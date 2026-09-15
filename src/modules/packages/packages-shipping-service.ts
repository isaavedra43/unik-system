import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ZohoApiError } from '@/modules/integrations/zoho/client';
import { isZohoBooksMockEnabled } from '@/modules/integrations/zoho/config';
import {
  createShipmentOrder,
  deleteShipmentOrder,
  extractPackageLineItems,
  extractShipmentOrder,
  markShipmentDelivered,
  updatePackage as updateZohoPackage,
  updateShipmentOrder,
} from '@/modules/integrations/zoho/shipments';
import { refreshPackageOnDemand } from '@/modules/integrations/zoho/packages-shipment-sweep';
import { PACKAGES_ENTITY_TYPE } from '@/modules/integrations/zoho/packages-sync';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { getPackageById } from './packages-service';
import type { PackageDetail } from './packages-contract';

/**
 * Shipping flow of a package, mirrored in Zoho:
 *   ship / edit shipment → Zoho shipment order (create or update) → re-read package → DB.
 *   mark delivered       → Zoho status/delivered                  → re-read → DB.
 *   cancel shipment      → Zoho delete shipment order             → re-read → DB.
 *   edit package         → Zoho PUT /packages/{id}                → re-read → DB.
 * Zoho is the source of truth: after every write the package DETAIL is read back so what UNIK
 * shows is exactly what Zoho stored. If that read-back can't happen right now (rate budget), the
 * values are applied locally and the row is flagged so the shipment sweep re-reads it soon.
 * With ZOHO_BOOKS_MOCK=true nothing is sent to Zoho; the change is simulated in the DB.
 */

export class PackageShippingError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    /** HTTP status Zoho answered, when the error comes from Zoho. */
    public readonly upstreamStatus?: number
  ) {
    super(message);
    this.name = 'PackageShippingError';
  }
}

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');

export const shipmentInputSchema = z.object({
  carrier: z.string().trim().min(1, 'Elige o escribe el transportista').max(100),
  date: isoDay,
  trackingNumber: z.string().trim().max(100).optional().or(z.literal('')),
  trackingUrl: z
    .string()
    .trim()
    .max(500)
    .url('URL de seguimiento inválida')
    .optional()
    .or(z.literal('')),
  shippingCharge: z.coerce.number().min(0).optional().nullable(),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  /** "Envío ya entregado" */
  delivered: z.boolean().optional().default(false),
  deliveryDate: isoDay.optional().or(z.literal('')),
});
export type ShipmentInput = z.infer<typeof shipmentInputSchema>;

export const packageEditSchema = z.object({
  date: isoDay.optional().or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});
export type PackageEditInput = z.infer<typeof packageEditSchema>;

interface Actor {
  id: string;
}

const PKG_SELECT = {
  id: true,
  zohoPackageId: true,
  zohoSalesOrderId: true,
  zohoShipmentId: true,
  shipmentNumber: true,
  packageNumber: true,
  status: true,
  date: true,
} as const;

/** Zoho demands `line_items` on every package update: take them from the last detail Zoho sent us. */
async function currentLineItems(zohoPackageId: string) {
  const snapshot = await prisma.integrationSnapshot.findFirst({
    where: { source: 'zoho', entityType: PACKAGES_ENTITY_TYPE, externalId: zohoPackageId },
    orderBy: { remoteModifiedAt: 'desc' },
    select: { payload: true },
  });
  return extractPackageLineItems(snapshot?.payload);
}

async function loadPackage(id: string) {
  const pkg = await prisma.package.findUnique({ where: { id }, select: PKG_SELECT });
  if (!pkg) throw new PackageShippingError('Paquete no encontrado', 404);
  if (!pkg.zohoSalesOrderId)
    throw new PackageShippingError(
      'El paquete no tiene orden de venta en Zoho; no se puede enviar desde aquí.',
      409
    );
  return pkg;
}

function zohoMessage(error: unknown, fallback: string): PackageShippingError {
  if (error instanceof PackageShippingError) return error;
  if (error instanceof ZohoApiError) {
    const msg = error.zohoMessage ?? `Zoho respondió ${error.httpStatus ?? 'con error'}`;
    const hint = /shipment_number|número de env/i.test(msg)
      ? ' Activa la numeración automática de órdenes de envío en Zoho (icono de engrane junto al número).'
      : '';
    return new PackageShippingError(`${fallback}: ${msg}${hint}`, 502, error.httpStatus);
  }
  if (error instanceof Error && error.message.startsWith('Invalid or missing Zoho')) {
    return new PackageShippingError('Faltan credenciales de Zoho en el servidor.', 503);
  }
  return new PackageShippingError(fallback, 502);
}

/** After a Zoho write: re-read the package so the DB mirrors Zoho. Falls back to a local patch. */
async function readBackOrPatch(
  id: string,
  patch: Prisma.PackageUpdateInput
): Promise<'zoho' | 'local'> {
  const outcome = await refreshPackageOnDemand(id, { force: true });
  if (outcome.status === 'refreshed') return 'zoho';
  await prisma.package.update({ where: { id }, data: { ...patch, lastDetailFetchedAt: null } });
  return 'local';
}

async function finish(id: string): Promise<PackageDetail> {
  const detail = await getPackageById(id);
  if (!detail) throw new PackageShippingError('Paquete no encontrado', 404);
  return detail;
}

/** Carrier names seen in Zoho shipments (the manual carrier list is not exposed by the API). */
export async function getCarrierOptions(): Promise<string[]> {
  const [byCarrier, byMethod] = await Promise.all([
    prisma.package.groupBy({
      by: ['carrier'],
      where: { carrier: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { carrier: 'desc' } },
      take: 100,
    }),
    prisma.package.groupBy({
      by: ['deliveryMethod'],
      where: { deliveryMethod: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { deliveryMethod: 'desc' } },
      take: 100,
    }),
  ]);
  const names = new Map<string, number>();
  for (const r of byCarrier)
    if (r.carrier?.trim())
      names.set(r.carrier.trim(), (names.get(r.carrier.trim()) ?? 0) + r._count._all);
  for (const r of byMethod)
    if (r.deliveryMethod?.trim() && !names.has(r.deliveryMethod.trim()))
      names.set(r.deliveryMethod.trim(), r._count._all);
  return [...names.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([n]) => n);
}

/** Creates the shipment order (first time) or updates it (already shipped). */
export async function shipPackage(actor: Actor, id: string, raw: unknown): Promise<PackageDetail> {
  const input = shipmentInputSchema.parse(raw);
  const pkg = await loadPackage(id);
  const mock = isZohoBooksMockEnabled();
  const creating = !pkg.zohoShipmentId;
  const zohoInput = {
    date: input.date,
    delivery_method: input.carrier,
    tracking_number: input.trackingNumber || undefined,
    tracking_url: input.trackingUrl || undefined,
    shipping_charge: input.shippingCharge ?? undefined,
    notes: input.notes ?? '',
  };

  let shipmentId = pkg.zohoShipmentId;
  let shipmentNumber = pkg.shipmentNumber;
  let source: 'zoho' | 'local' | 'mock' = 'mock';
  try {
    if (!mock) {
      const response = creating
        ? await createShipmentOrder({
            packageId: pkg.zohoPackageId,
            salesOrderId: pkg.zohoSalesOrderId!,
            input: zohoInput,
          })
        : await updateShipmentOrder({
            shipmentId: pkg.zohoShipmentId!,
            packageId: pkg.zohoPackageId,
            salesOrderId: pkg.zohoSalesOrderId!,
            input: zohoInput,
          });
      const so = extractShipmentOrder(response);
      shipmentId = so?.shipment_id ?? shipmentId;
      shipmentNumber = so?.shipment_number ?? shipmentNumber;
      if (input.delivered && shipmentId)
        await markShipmentDelivered(shipmentId, input.deliveryDate || input.date);
    } else {
      shipmentId = shipmentId ?? `mock-${Date.now()}`;
      shipmentNumber = shipmentNumber ?? `NE-MOCK-${pkg.packageNumber ?? pkg.id.slice(-5)}`;
    }
  } catch (error) {
    throw zohoMessage(
      error,
      creating
        ? 'No se pudo crear la orden de envío en Zoho'
        : 'No se pudo actualizar la orden de envío en Zoho'
    );
  }

  const patch: Prisma.PackageUpdateInput = {
    carrier: input.carrier,
    deliveryMethod: input.carrier,
    shipmentDate: new Date(`${input.date}T00:00:00.000Z`),
    trackingNumber: input.trackingNumber || null,
    trackingUrl: input.trackingUrl || null,
    shippingCharge: input.shippingCharge ?? null,
    notes: input.notes || null,
    zohoShipmentId: shipmentId,
    shipmentNumber,
    status: input.delivered ? 'delivered' : 'shipped',
    shipmentStatus: input.delivered ? 'delivered' : 'shipped',
    deliveryDate: input.delivered
      ? new Date(`${input.deliveryDate || input.date}T00:00:00.000Z`)
      : null,
  };
  if (mock) await prisma.package.update({ where: { id }, data: patch });
  else source = await readBackOrPatch(id, patch);

  await recordAuditEvent({
    actorUserId: actor.id,
    action: creating ? 'packages.shipped' : 'packages.shipment_updated',
    targetType: 'Package',
    targetId: id,
    metadata: {
      zohoPackageId: pkg.zohoPackageId,
      zohoShipmentId: shipmentId,
      carrier: input.carrier,
      date: input.date,
      delivered: input.delivered,
      source,
    },
  });
  return finish(id);
}

export async function markPackageDelivered(
  actor: Actor,
  id: string,
  deliveredDate?: string | null
): Promise<PackageDetail> {
  const pkg = await loadPackage(id);
  if (!pkg.zohoShipmentId)
    throw new PackageShippingError(
      'El paquete aún no tiene orden de envío; primero asigna el transportista.',
      409
    );
  const day =
    deliveredDate && isoDay.safeParse(deliveredDate).success
      ? deliveredDate
      : new Date().toISOString().slice(0, 10);
  const mock = isZohoBooksMockEnabled();
  let source: 'zoho' | 'local' | 'mock' = 'mock';
  try {
    if (!mock) await markShipmentDelivered(pkg.zohoShipmentId, day);
  } catch (error) {
    throw zohoMessage(error, 'No se pudo marcar como entregado en Zoho');
  }
  const patch: Prisma.PackageUpdateInput = {
    status: 'delivered',
    shipmentStatus: 'delivered',
    deliveryDate: new Date(`${day}T00:00:00.000Z`),
  };
  if (mock) await prisma.package.update({ where: { id }, data: patch });
  else source = await readBackOrPatch(id, patch);
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'packages.delivered',
    targetType: 'Package',
    targetId: id,
    metadata: {
      zohoPackageId: pkg.zohoPackageId,
      zohoShipmentId: pkg.zohoShipmentId,
      deliveredDate: day,
      source,
    },
  });
  return finish(id);
}

/** Deletes the shipment order in Zoho: the package goes back to "not shipped". */
export async function cancelPackageShipment(actor: Actor, id: string): Promise<PackageDetail> {
  const pkg = await loadPackage(id);
  if (!pkg.zohoShipmentId)
    throw new PackageShippingError('El paquete no tiene orden de envío.', 409);
  const mock = isZohoBooksMockEnabled();
  let source: 'zoho' | 'local' | 'mock' = 'mock';
  try {
    if (!mock) await deleteShipmentOrder(pkg.zohoShipmentId);
  } catch (error) {
    throw zohoMessage(error, 'No se pudo eliminar la orden de envío en Zoho');
  }
  const patch: Prisma.PackageUpdateInput = {
    carrier: null,
    deliveryMethod: null,
    shipmentDate: null,
    trackingNumber: null,
    trackingUrl: null,
    shippingCharge: null,
    zohoShipmentId: null,
    shipmentNumber: null,
    deliveryDate: null,
    status: 'not_shipped',
    shipmentStatus: null,
  };
  if (mock) await prisma.package.update({ where: { id }, data: patch });
  else source = await readBackOrPatch(id, patch);
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'packages.shipment_cancelled',
    targetType: 'Package',
    targetId: id,
    metadata: { zohoPackageId: pkg.zohoPackageId, zohoShipmentId: pkg.zohoShipmentId, source },
  });
  return finish(id);
}

/** Edits the package's own date / notes in Zoho. */
export async function editPackage(actor: Actor, id: string, raw: unknown): Promise<PackageDetail> {
  const input = packageEditSchema.parse(raw);
  const pkg = await loadPackage(id);
  const mock = isZohoBooksMockEnabled();
  let source: 'zoho' | 'local' | 'mock' = 'mock';
  try {
    if (!mock) {
      const lineItems = await currentLineItems(pkg.zohoPackageId);
      if (lineItems.length === 0)
        throw new PackageShippingError(
          'Zoho exige los artículos del paquete para editarlo y aún no se han leído. Pulsa “Actualizar desde Zoho” e intenta de nuevo.',
          409
        );
      const date = input.date || (pkg.date ? pkg.date.toISOString().slice(0, 10) : null);
      if (!date) throw new PackageShippingError('Indica la fecha del paquete.', 400);
      await updateZohoPackage({
        packageId: pkg.zohoPackageId,
        salesOrderId: pkg.zohoSalesOrderId!,
        input: { date, notes: input.notes ?? undefined, line_items: lineItems },
      });
    }
  } catch (error) {
    throw zohoMessage(error, 'No se pudo editar el paquete en Zoho');
  }
  const patch: Prisma.PackageUpdateInput = {
    ...(input.date ? { date: new Date(`${input.date}T00:00:00.000Z`) } : {}),
    ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
  };
  if (mock) await prisma.package.update({ where: { id }, data: patch });
  else source = await readBackOrPatch(id, patch);
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'packages.edited',
    targetType: 'Package',
    targetId: id,
    metadata: { zohoPackageId: pkg.zohoPackageId, date: input.date || null, source },
  });
  return finish(id);
}
