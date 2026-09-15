import { z } from 'zod';
import { Prisma, type DeliveryOrder, type DemandAllocation, type Package } from '@prisma/client';
import {
  OperationsError,
  requireCommandContext,
  type CommandContext,
} from '@/modules/operations/commands';
import { toOperationalJson } from '@/modules/operations/events-service';
import { OPS_EVENTS } from '@/modules/operations/types';
import { JOB_PRIORITY } from '@/modules/jobs/job-queue';
import {
  demandFulfillment,
  EVIDENCE_INVALID_OBJECT_STATUSES,
  expectedQuantity,
  hasPhysicalEvidence,
  QUANTITY_EPSILON,
  summarizeDelivery,
  type AllocationExpectation,
  type DeliverySummary,
  chooseLinkablePackage,
} from './delivery-rules';
import {
  actorUserId,
  assertDriverOrDispatcher,
  bumpDeliveryOrder,
  caseReference,
  closeOpenAreaRequests,
  closeOpenWorkItems,
  dayText,
  deliveryRef,
  idText,
  instantText,
  latitude,
  loadDeliveryOrder,
  logisticsError,
  longitude,
  parseInstant,
  publishDeliveryChange,
  readShipmentInput,
  requireDay,
  toDecimal,
  toNumberOrZero,
  type Tx,
} from './logistics-helpers';
import {
  ALLOCATION_DELIVERABLE_STATUSES,
  DELIVERY_MODES,
  DELIVERY_ORDER_OPEN_STATUSES,
  DELIVERY_ORDER_STATUS_LABELS,
  DIRECT_SUPPLIER_ALLOCATION_STATUSES,
  LOGISTICS_EVENTS,
  LOGISTICS_JOB_TYPES,
  LOGISTICS_OBJECT_TYPES,
  LOGISTICS_ZOHO_MAX_ATTEMPTS,
  PHYSICAL_EVIDENCE_KINDS,
  TRIP_STOP_OPEN_STATUSES,
  isDeliveryOrderOpen,
  isDeliveryOrderStatus,
  zohoCancelKey,
  zohoDeliveredKey,
  SHIPPING_MODES,
} from './types';
import { transitionZohoSync } from './zoho-sync-state';

/**
 * Delivery orders of an operational case (plan sections 4.1, 4.3 and 6.3).
 *
 * - `createDeliveryOrder`: from the `planear_entrega` step. Links the Zoho
 *   package of the sales order (`Package.zohoSalesOrderId`); without a free
 *   package the order waits (`pending`) behind an `AreaRequest
 *   create_package_in_zoho` to Ventas that blocks the delivery.
 * - `linkPackage`: attaches the package when Zoho has it (manual or by the
 *   30-minute sweep) and resolves that request.
 * - `recordDelivery`: delivered lines with physical evidence. Complete →
 *   `delivered` + outbox `ops.zoho.mark_delivered`; short → `partially_delivered`,
 *   allocations `reopened`, child delivery order for the remainder, incident
 *   `partial_delivery` and a work item to Ventas "Decidir remanente".
 * - `cancelDeliveryOrder`: compensates (outbox `ops.zoho.cancel_shipment` when
 *   UNIK wrote a shipment order) and closes what hung from the order.
 *
 * Every function runs inside a command (`requireCommandContext`).
 */

const ORDER = LOGISTICS_OBJECT_TYPES.deliveryOrder;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const deliveryDestinationSchema = z.object({
  addressLine: z.string().trim().max(500).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  state: z.string().trim().max(120).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  contactName: z.string().trim().max(200).nullable().optional(),
  contactPhone: z.string().trim().max(40).nullable().optional(),
  lat: latitude.nullable().optional(),
  lng: longitude.nullable().optional(),
  plannedDate: dayText.nullable().optional(),
  windowStart: instantText.nullable().optional(),
  windowEnd: instantText.nullable().optional(),
});

export const createDeliveryOrderSchema = deliveryDestinationSchema.extend({
  caseId: idText,
  allocationIds: z.array(idText).min(1).max(100),
  mode: z.enum(DELIVERY_MODES),
  /** Explicit package; otherwise the first free package of the sales order. */
  packageId: idText.nullable().optional(),
});
export type CreateDeliveryOrderInput = z.infer<typeof createDeliveryOrderSchema>;

export const linkPackageSchema = z.object({
  deliveryOrderId: idText,
  packageId: idText.nullable().optional(),
});
export type LinkPackageInput = z.infer<typeof linkPackageSchema>;

/** Fields of a delivery record (shared by `delivery.record` and `trip.complete_stop`). */
export const deliveryRecordFieldsSchema = z.object({
  lines: z
    .array(z.object({ allocationId: idText, deliveredQty: z.number().finite().min(0) }))
    .min(1)
    .max(100),
  receivedBy: z.string().trim().min(1, 'Indica quién recibió').max(200),
  /** Storage objects uploaded to the `delivery_evidence` target of this order. */
  evidenceObjectIds: z.array(idText).max(20).default([]),
  note: z.string().trim().max(1000).optional(),
  partialReason: z.string().trim().max(500).optional(),
  lat: latitude.nullable().optional(),
  lng: longitude.nullable().optional(),
});
export type DeliveryRecordFields = z.infer<typeof deliveryRecordFieldsSchema>;

export const recordDeliverySchema = deliveryRecordFieldsSchema.extend({ deliveryOrderId: idText });
export type RecordDeliveryInput = z.infer<typeof recordDeliverySchema>;

export const cancelDeliveryOrderSchema = z.object({
  deliveryOrderId: idText,
  reason: z.string().trim().min(1, 'Indica el motivo').max(500),
});
export type CancelDeliveryOrderInput = z.infer<typeof cancelDeliveryOrderSchema>;

// ---------------------------------------------------------------------------
// Extension hook: reactions to a recorded delivery in the same transaction
// ---------------------------------------------------------------------------

export interface DeliveryRecordedEvent {
  deliveryOrder: DeliveryOrder;
  summary: DeliverySummary;
  childDeliveryOrderId: string | null;
  ctx: CommandContext;
}

export type DeliveryRecordedListener = (tx: Tx, event: DeliveryRecordedEvent) => Promise<void>;

type GlobalWithDeliveryListeners = typeof globalThis & {
  __unikDeliveryRecordedListeners?: Set<DeliveryRecordedListener>;
};

function deliveryListeners(): Set<DeliveryRecordedListener> {
  const scope = globalThis as GlobalWithDeliveryListeners;
  if (!scope.__unikDeliveryRecordedListeners) scope.__unikDeliveryRecordedListeners = new Set();
  return scope.__unikDeliveryRecordedListeners;
}

/**
 * Registers a reaction that runs inside the delivery transaction (e.g. the
 * inventory module consuming the stock reservations of the delivered
 * allocations). A throwing listener rejects the whole delivery command.
 */
export function onDeliveryRecorded(listener: DeliveryRecordedListener): () => void {
  deliveryListeners().add(listener);
  return () => {
    deliveryListeners().delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

export function isDeliveredPackage(pkg: Pick<Package, 'status' | 'shipmentStatus'>): boolean {
  return [pkg.status, pkg.shipmentStatus].some((s) => (s ?? '').toLowerCase() === 'delivered');
}

/**
 * The package of the sales order that belongs to a delivery order: free (not
 * delivered nor taken by another live delivery order) and whose lines are the
 * items of the order's allocations (see `chooseLinkablePackage`). With split
 * deliveries a package is never linked by date to the wrong order.
 */
export async function findLinkablePackage(
  tx: Tx,
  zohoSalesOrderId: string,
  options: { allocationIds: readonly string[]; excludeDeliveryOrderId?: string }
): Promise<Package | null> {
  const packages = await tx.package.findMany({
    where: { zohoSalesOrderId },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  });
  const candidates = packages.filter((pkg) => !isDeliveredPackage(pkg));
  if (candidates.length === 0) return null;
  const taken = await tx.deliveryOrder.findMany({
    where: {
      packageId: { in: candidates.map((pkg) => pkg.id) },
      status: { not: 'cancelled' },
      ...(options.excludeDeliveryOrderId ? { id: { not: options.excludeDeliveryOrderId } } : {}),
    },
    select: { packageId: true },
  });
  const takenIds = new Set(taken.map((row) => row.packageId));
  const free = candidates.filter((pkg) => !takenIds.has(pkg.id));
  if (free.length === 0) return null;
  const allocations = await tx.demandAllocation.findMany({
    where: { id: { in: [...options.allocationIds] } },
    select: { demandId: true },
  });
  const demands = await tx.caseDemand.findMany({
    where: { id: { in: [...new Set(allocations.map((a) => a.demandId))] } },
    select: { zohoItemId: true },
  });
  const items = await tx.packageItem.findMany({
    where: { packageId: { in: free.map((pkg) => pkg.id) } },
    select: { packageId: true, zohoItemId: true },
  });
  const chosen = chooseLinkablePackage(
    free.map((pkg) => ({
      id: pkg.id,
      itemIds: items
        .filter((item) => item.packageId === pkg.id && item.zohoItemId)
        .map((item) => item.zohoItemId as string),
    })),
    demands.map((demand) => demand.zohoItemId).filter((id): id is string => Boolean(id))
  );
  return free.find((pkg) => pkg.id === chosen) ?? null;
}

/** Attaches a package to an order in the command's transaction and resolves the package request. */
export async function attachPackage(
  ctx: CommandContext,
  order: DeliveryOrder,
  pkg: Package
): Promise<DeliveryOrder> {
  const updated = await ctx.tx.deliveryOrder.update({
    where: { id: order.id },
    data: {
      packageId: pkg.id,
      zohoPackageId: pkg.zohoPackageId,
      status: order.status === 'pending' ? 'planned' : order.status,
      addressLine: order.addressLine ?? pkg.shippingAddress,
      city: order.city ?? pkg.shippingCity,
      state: order.state ?? pkg.shippingState,
      postalCode: order.postalCode ?? pkg.shippingZip,
      contactName: order.contactName ?? pkg.shippingAttention,
      contactPhone: order.contactPhone ?? pkg.shippingPhone,
    },
  });
  await ctx.relate(
    deliveryRef(order.id),
    { type: LOGISTICS_OBJECT_TYPES.package, id: pkg.id },
    'ships_with'
  );
  await closeOpenAreaRequests(
    ctx,
    { objectType: ORDER, objectId: order.id, kind: 'create_package_in_zoho' },
    {
      status: 'resolved',
      answer: {
        packageId: pkg.id,
        zohoPackageId: pkg.zohoPackageId,
        packageNumber: pkg.packageNumber,
      },
    }
  );
  ctx.emit(
    LOGISTICS_EVENTS.delivery.packageLinked,
    {
      deliveryOrderId: order.id,
      packageId: pkg.id,
      zohoPackageId: pkg.zohoPackageId,
      packageNumber: pkg.packageNumber,
    },
    { caseId: order.caseId, areaKey: 'logistica', objectType: ORDER, objectId: order.id }
  );
  return updated;
}

// ---------------------------------------------------------------------------
// createDeliveryOrder
// ---------------------------------------------------------------------------

function toExpectation(allocation: DemandAllocation): AllocationExpectation {
  return {
    allocationId: allocation.id,
    demandId: allocation.demandId,
    quantity: toNumberOrZero(allocation.quantity),
    deliveredQuantity: toNumberOrZero(allocation.deliveredQuantity),
  };
}

function parseWindow(input: { windowStart?: string | null; windowEnd?: string | null }) {
  const windowStart = parseInstant(input.windowStart, 'el inicio de la ventana');
  const windowEnd = parseInstant(input.windowEnd, 'el fin de la ventana');
  if (windowStart && windowEnd && windowStart.getTime() >= windowEnd.getTime()) {
    throw new OperationsError('invalid_payload', 'La ventana de entrega termina antes de empezar');
  }
  return { windowStart, windowEnd };
}

export interface CreateDeliveryOrderResult {
  deliveryOrder: DeliveryOrder;
  packageLinked: boolean;
  areaRequestId: string | null;
  workItemId: string | null;
}

export async function createDeliveryOrder(
  tx: Tx,
  input: CreateDeliveryOrderInput
): Promise<CreateDeliveryOrderResult> {
  const ctx = requireCommandContext(tx);
  const allocationIds = [...new Set(input.allocationIds)];
  const opCase = await tx.operationalCase.findUnique({ where: { id: input.caseId } });
  if (!opCase) throw new OperationsError('not_found', 'No se encontró el expediente');
  if (opCase.status === 'closed' || opCase.status === 'cancelled') {
    throw new OperationsError('invalid_state', 'El expediente está cerrado o cancelado');
  }
  const { windowStart, windowEnd } = parseWindow(input);
  const plannedDate = input.plannedDate ? requireDay(input.plannedDate, 'la fecha planeada') : null;

  const allocations = await tx.demandAllocation.findMany({
    where: { id: { in: allocationIds }, caseId: opCase.id },
  });
  if (allocations.length !== allocationIds.length) {
    throw new OperationsError(
      'invalid_payload',
      'Alguna asignación no existe o no pertenece a este expediente'
    );
  }
  const allowed: readonly string[] =
    input.mode === 'direct_supplier'
      ? DIRECT_SUPPLIER_ALLOCATION_STATUSES
      : ALLOCATION_DELIVERABLE_STATUSES;
  const notReady = allocations.filter((a) => !allowed.includes(a.status));
  if (notReady.length > 0) {
    throw new OperationsError(
      'invalid_state',
      `El material aún no está listo para entregarse (${notReady.length} de ${allocations.length} asignaciones)`,
      { details: { allocationIds: notReady.map((a) => a.id) } }
    );
  }
  const nothingOwed = allocations.filter(
    (a) => expectedQuantity(toExpectation(a)) <= QUANTITY_EPSILON
  );
  if (nothingOwed.length > 0) {
    throw new OperationsError(
      'invalid_state',
      'Hay asignaciones que ya se entregaron por completo',
      {
        details: { allocationIds: nothingOwed.map((a) => a.id) },
      }
    );
  }
  const busy = await tx.deliveryOrder.findMany({
    where: {
      caseId: opCase.id,
      status: { in: [...DELIVERY_ORDER_OPEN_STATUSES] },
      allocationIds: { hasSome: allocationIds },
    },
    select: { id: true },
  });
  if (busy.length > 0) {
    throw logisticsError(
      'allocation_in_delivery',
      'Alguna asignación ya está en otra orden de entrega abierta',
      { deliveryOrderIds: busy.map((row) => row.id) }
    );
  }

  let pkg: Package | null = null;
  if (input.packageId) {
    pkg = await tx.package.findUnique({ where: { id: input.packageId } });
    if (!pkg || !opCase.zohoSalesOrderId || pkg.zohoSalesOrderId !== opCase.zohoSalesOrderId) {
      throw new OperationsError(
        'invalid_payload',
        'El paquete no corresponde a la orden de venta del expediente'
      );
    }
    if (!(await isPackageFree(tx, pkg))) {
      throw new OperationsError(
        'invalid_state',
        'El paquete ya está en otra orden de entrega o fue entregado'
      );
    }
  } else if (opCase.zohoSalesOrderId) {
    pkg = await findLinkablePackage(tx, opCase.zohoSalesOrderId, { allocationIds });
  }
  const waitingForPackage = !pkg && Boolean(opCase.zohoSalesOrderId);

  const order = await tx.deliveryOrder.create({
    data: {
      caseId: opCase.id,
      allocationIds,
      packageId: pkg?.id ?? null,
      zohoPackageId: pkg?.zohoPackageId ?? null,
      mode: input.mode,
      status: waitingForPackage ? 'pending' : 'planned',
      plannedDate,
      windowStart,
      windowEnd,
      addressLine: input.addressLine ?? pkg?.shippingAddress ?? null,
      city: input.city ?? pkg?.shippingCity ?? null,
      state: input.state ?? pkg?.shippingState ?? null,
      postalCode: input.postalCode ?? pkg?.shippingZip ?? null,
      contactName: input.contactName ?? pkg?.shippingAttention ?? opCase.customerName ?? null,
      contactPhone: input.contactPhone ?? pkg?.shippingPhone ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      zohoSyncState: 'not_required',
    },
  });

  await ctx.relate(
    { type: LOGISTICS_OBJECT_TYPES.case, id: opCase.id },
    deliveryRef(order.id),
    'has_delivery'
  );
  if (pkg) {
    await ctx.relate(
      deliveryRef(order.id),
      { type: LOGISTICS_OBJECT_TYPES.package, id: pkg.id },
      'ships_with'
    );
  }
  for (const allocation of allocations) {
    await ctx.relate(
      deliveryRef(order.id),
      { type: LOGISTICS_OBJECT_TYPES.allocation, id: allocation.id },
      'covers'
    );
  }
  ctx.emit(
    OPS_EVENTS.delivery.planned,
    {
      deliveryOrderId: order.id,
      mode: order.mode,
      status: order.status,
      allocationIds,
      packageId: order.packageId,
      plannedDate: input.plannedDate ?? null,
    },
    { caseId: opCase.id, areaKey: 'logistica', objectType: ORDER, objectId: order.id }
  );

  let areaRequestId: string | null = null;
  let workItemId: string | null = null;
  if (waitingForPackage && opCase.zohoSalesOrderId) {
    const demands = await tx.caseDemand.findMany({
      where: { id: { in: [...new Set(allocations.map((a) => a.demandId))] } },
    });
    const lines = allocations.map((allocation) => {
      const demand = demands.find((d) => d.id === allocation.demandId);
      return {
        lineRef: demand?.lineRef ?? allocation.id,
        sku: demand?.sku || undefined,
        name: demand?.name || 'Artículo',
        qty: expectedQuantity(toExpectation(allocation)),
        unit: demand?.baseUnit || undefined,
      };
    });
    const { request, workItem } = await ctx.createAreaRequest({
      caseId: opCase.id,
      fromAreaKey: 'logistica',
      toAreaKey: 'ventas',
      kind: 'create_package_in_zoho',
      objectType: ORDER,
      objectId: order.id,
      title: `Crear paquete en Zoho de ${opCase.salesOrderNumber ?? opCase.caseNumber}`,
      payload: { caseId: opCase.id, zohoSalesOrderId: opCase.zohoSalesOrderId, lines },
      blocksDelivery: true,
    });
    areaRequestId = request.id;
    workItemId = workItem.id;
    ctx.emit(
      LOGISTICS_EVENTS.delivery.packageRequested,
      { deliveryOrderId: order.id, areaRequestId, zohoSalesOrderId: opCase.zohoSalesOrderId },
      { caseId: opCase.id, areaKey: 'logistica', objectType: ORDER, objectId: order.id }
    );
  }

  publishDeliveryChange(ctx, order);
  return { deliveryOrder: order, packageLinked: Boolean(pkg), areaRequestId, workItemId };
}

async function isPackageFree(tx: Tx, pkg: Package): Promise<boolean> {
  if (isDeliveredPackage(pkg)) return false;
  const taken = await tx.deliveryOrder.findFirst({
    where: { packageId: pkg.id, status: { not: 'cancelled' } },
    select: { id: true },
  });
  return !taken;
}

// ---------------------------------------------------------------------------
// linkPackage
// ---------------------------------------------------------------------------

export async function linkPackage(
  tx: Tx,
  input: LinkPackageInput
): Promise<{ deliveryOrder: DeliveryOrder; linked: boolean }> {
  const ctx = requireCommandContext(tx);
  const order = await loadDeliveryOrder(tx, input.deliveryOrderId);
  if (order.packageId) return { deliveryOrder: order, linked: false };
  if (!isDeliveryOrderOpen(order.status)) {
    throw new OperationsError('invalid_state', 'La entrega ya está cerrada');
  }
  const opCase = await tx.operationalCase.findUnique({
    where: { id: order.caseId },
    select: { zohoSalesOrderId: true },
  });
  if (!opCase?.zohoSalesOrderId) {
    throw new OperationsError('invalid_state', 'El expediente no tiene orden de venta de Zoho');
  }
  let pkg: Package | null;
  if (input.packageId) {
    pkg = await tx.package.findUnique({ where: { id: input.packageId } });
    if (!pkg || pkg.zohoSalesOrderId !== opCase.zohoSalesOrderId) {
      throw new OperationsError('invalid_payload', 'El paquete no corresponde a la orden de venta');
    }
    if (!(await isPackageFree(tx, pkg))) {
      throw new OperationsError(
        'invalid_state',
        'El paquete ya está en otra orden de entrega o fue entregado'
      );
    }
  } else {
    pkg = await findLinkablePackage(tx, opCase.zohoSalesOrderId, {
      allocationIds: order.allocationIds,
      excludeDeliveryOrderId: order.id,
    });
  }
  if (!pkg) {
    throw logisticsError(
      'package_missing',
      'Zoho aún no tiene un paquete libre para esta orden de venta; Ventas debe crearlo'
    );
  }
  const updated = await attachPackage(ctx, order, pkg);
  publishDeliveryChange(ctx, updated);
  return { deliveryOrder: updated, linked: true };
}

// ---------------------------------------------------------------------------
// recordDelivery
// ---------------------------------------------------------------------------

/**
 * The delivery must carry physical evidence of THIS attempt: the files listed in
 * the command or uploaded after the last failed stop of the order. A photo of a
 * previous, failed visit (a closed gate) never closes a later delivery.
 */
async function assertDeliveryEvidence(
  tx: Tx,
  deliveryOrderId: string,
  listedObjectIds: string[]
): Promise<void> {
  const all = await tx.deliveryEvidence.findMany({
    where: {
      deliveryOrderId,
      kind: { in: [...PHYSICAL_EVIDENCE_KINDS] },
      storageObjectId: { not: null },
    },
    select: { kind: true, storageObjectId: true, createdAt: true },
  });
  const lastFailure = await tx.tripStop.findFirst({
    where: { deliveryOrderId, status: 'failed', departedAt: { not: null } },
    orderBy: { departedAt: 'desc' },
    select: { departedAt: true },
  });
  const listed = new Set(listedObjectIds);
  const since = lastFailure?.departedAt?.getTime() ?? null;
  const evidences = all.filter(
    (e) =>
      listed.has(e.storageObjectId as string) || since === null || e.createdAt.getTime() > since
  );
  const known = new Set(all.map((e) => e.storageObjectId as string));
  const foreign = listedObjectIds.filter((id) => !known.has(id));
  if (foreign.length > 0) {
    throw logisticsError(
      'evidence_invalid',
      'Alguna evidencia no pertenece a esta entrega o no es una foto o firma',
      { objectIds: foreign }
    );
  }
  const objects = known.size
    ? await tx.storageObject.findMany({
        where: { id: { in: [...known] } },
        select: { id: true, status: true },
      })
    : [];
  const statusById = new Map(objects.map((o) => [o.id, o.status]));
  const invalid = listedObjectIds.filter((id) =>
    (EVIDENCE_INVALID_OBJECT_STATUSES as readonly string[]).includes(
      statusById.get(id) ?? 'missing'
    )
  );
  if (invalid.length > 0) {
    throw logisticsError(
      'evidence_invalid',
      'Alguna evidencia fue rechazada o ya no está en el almacenamiento; vuelve a subirla',
      { objectIds: invalid }
    );
  }
  const present = hasPhysicalEvidence(
    evidences.map((e) => ({
      kind: e.kind,
      objectStatus: statusById.get(e.storageObjectId as string) ?? null,
    }))
  );
  if (!present) {
    throw logisticsError(
      'evidence_required',
      'Falta la evidencia de entrega: sube una foto o la firma de quien recibe antes de cerrarla'
    );
  }
}

export interface RecordDeliveryResult {
  deliveryOrderId: string;
  status: 'delivered' | 'partially_delivered';
  complete: boolean;
  childDeliveryOrderId: string | null;
  zohoSyncState: string;
  zohoWriteQueued: boolean;
  totalDelivered: number;
  totalShort: number;
  incidentId: string | null;
}

/**
 * Records what was delivered. `orderVersionGuard` is true when the delivery
 * order is not the command aggregate (e.g. `trip.complete_stop`).
 */
export async function recordDelivery(
  tx: Tx,
  input: RecordDeliveryInput,
  options: { orderVersionGuard: boolean }
): Promise<RecordDeliveryResult> {
  const ctx = requireCommandContext(tx);
  const order = await loadDeliveryOrder(tx, input.deliveryOrderId);
  if (!isDeliveryOrderOpen(order.status)) {
    const label = isDeliveryOrderStatus(order.status)
      ? DELIVERY_ORDER_STATUS_LABELS[order.status]
      : order.status;
    throw new OperationsError(
      'invalid_state',
      `La entrega ya está cerrada (${label.toLowerCase()})`
    );
  }
  await assertDriverOrDispatcher(ctx, order.driverId, 'registrar esta entrega');
  if ((SHIPPING_MODES as readonly string[]).includes(order.mode) && !order.packageId) {
    // The «Crear paquete en Zoho» request blocks the delivery: it is an explicit wait.
    throw logisticsError(
      'package_missing',
      'Zoho aún no tiene paquete para esta entrega; Ventas debe crearlo antes de cerrarla'
    );
  }
  await assertDeliveryEvidence(tx, order.id, input.evidenceObjectIds);

  const allocations = await tx.demandAllocation.findMany({
    where: { id: { in: order.allocationIds } },
  });
  const summarized = summarizeDelivery(allocations.map(toExpectation), input.lines);
  if (!summarized.ok) {
    throw logisticsError(
      summarized.code === 'nothing_delivered' ? 'nothing_delivered' : 'invalid_quantity',
      summarized.message,
      { reason: summarized.code, allocationId: summarized.allocationId }
    );
  }
  const summary = summarized.summary;
  const eventOptions = { caseId: order.caseId, areaKey: 'logistica' };

  // Allocations
  for (const line of summary.lines) {
    const allocation = allocations.find((a) => a.id === line.allocationId)!;
    const updated = await tx.demandAllocation.updateMany({
      where: { id: allocation.id, version: allocation.version },
      data: {
        deliveredQuantity: { increment: toDecimal(line.deliveredQty) },
        status: line.fullyDelivered ? 'delivered' : 'reopened',
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new OperationsError(
        'concurrency_conflict',
        'Una asignación cambió mientras se registraba la entrega; intenta de nuevo'
      );
    }
    ctx.emit(
      line.fullyDelivered ? OPS_EVENTS.allocation.delivered : OPS_EVENTS.allocation.reopened,
      {
        allocationId: allocation.id,
        demandId: allocation.demandId,
        deliveryOrderId: order.id,
        deliveredQty: line.deliveredQty,
        remainingQty: line.shortQty,
      },
      { ...eventOptions, objectType: LOGISTICS_OBJECT_TYPES.allocation, objectId: allocation.id }
    );
  }

  // Demands
  const addedByDemand = new Map<string, number>();
  for (const line of summary.lines) {
    if (line.deliveredQty > 0) {
      addedByDemand.set(line.demandId, (addedByDemand.get(line.demandId) ?? 0) + line.deliveredQty);
    }
  }
  if (addedByDemand.size > 0) {
    const demands = await tx.caseDemand.findMany({
      where: { id: { in: [...addedByDemand.keys()] } },
    });
    for (const demand of demands) {
      const next = demandFulfillment(
        toNumberOrZero(demand.baseQuantity),
        toNumberOrZero(demand.fulfilledQuantity),
        addedByDemand.get(demand.id) ?? 0
      );
      const becomesFulfilled =
        next.fulfilled && demand.status !== 'fulfilled' && demand.status !== 'cancelled';
      const res = await tx.caseDemand.updateMany({
        where: { id: demand.id, version: demand.version },
        data: {
          fulfilledQuantity: toDecimal(next.fulfilledQuantity),
          ...(becomesFulfilled ? { status: 'fulfilled' } : {}),
          version: { increment: 1 },
        },
      });
      if (res.count !== 1) {
        throw new OperationsError(
          'concurrency_conflict',
          'Una necesidad del expediente cambió mientras se registraba la entrega; intenta de nuevo'
        );
      }
      if (becomesFulfilled) {
        ctx.emit(
          OPS_EVENTS.demand.fulfilled,
          {
            demandId: demand.id,
            fulfilledQuantity: next.fulfilledQuantity,
            deliveryOrderId: order.id,
          },
          { ...eventOptions, objectType: 'case_demand', objectId: demand.id }
        );
      }
    }
  }

  // Quantity confirmation (append-only evidence)
  const deliveredLines = summary.lines.map((l) => ({
    allocationId: l.allocationId,
    deliveredQty: l.deliveredQty,
    expectedQty: l.expectedQty,
    shortQty: l.shortQty,
  }));
  await tx.deliveryEvidence.create({
    data: {
      deliveryOrderId: order.id,
      kind: 'qty_confirmation',
      deliveredLines: toOperationalJson(deliveredLines),
      note: input.note ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      commandId: ctx.commandId,
      createdBy: ctx.actor.id,
    },
  });
  await tx.evidenceLink.create({
    data: {
      caseId: order.caseId,
      objectType: ORDER,
      objectId: order.id,
      kind: 'count',
      note: `Recibió ${input.receivedBy}: ${summary.totalDelivered} entregado${
        summary.complete ? '' : `, faltan ${summary.totalShort}`
      }`.slice(0, 1000),
      createdBy: ctx.actor.id,
    },
  });

  // Zoho: mark the shipment delivered when there is (or will be) one.
  const pkg = order.packageId
    ? await tx.package.findUnique({
        where: { id: order.packageId },
        select: { zohoShipmentId: true },
      })
    : null;
  const shipment = readShipmentInput(order.shipmentInput);
  const zohoOwed = Boolean(pkg) && Boolean(order.zohoShipmentId || pkg?.zohoShipmentId || shipment);
  let zohoSyncState = order.zohoSyncState;
  if (zohoOwed) {
    const transition = transitionZohoSync(order.zohoSyncState, 'delivery_write_requested');
    if (transition.ok) {
      zohoSyncState = transition.state;
      const shipmentInFlight =
        order.zohoSyncState === 'pending_write' || order.zohoSyncState === 'written';
      ctx.outbox({
        type: LOGISTICS_JOB_TYPES.markDelivered,
        payload: { deliveryOrderId: order.id, requestedByUserId: actorUserId(ctx) },
        dedupeKey: zohoDeliveredKey(order.id),
        groupKey: `case:${order.caseId}`,
        maxAttempts: LOGISTICS_ZOHO_MAX_ATTEMPTS,
        priority: JOB_PRIORITY.normal,
        // Let a shipment order still being written land first.
        runAt: shipmentInFlight ? new Date(ctx.now.getTime() + 2 * 60_000) : undefined,
        createdBy: actorUserId(ctx) ?? undefined,
      });
    }
  }
  const zohoWriteQueued = zohoSyncState === 'delivered_pending_write' && zohoOwed;

  const status = summary.complete ? 'delivered' : 'partially_delivered';
  const data: Prisma.DeliveryOrderUpdateManyMutationInput = {
    status,
    deliveredAt: ctx.now,
    receivedBy: input.receivedBy,
    deliveredLines: toOperationalJson(deliveredLines),
    partialReason: summary.complete ? null : (input.partialReason ?? null),
    zohoSyncState,
  };
  const updated = options.orderVersionGuard
    ? await bumpDeliveryOrder(tx, order, data)
    : await tx.deliveryOrder.update({ where: { id: order.id }, data });

  if (order.tripId) {
    const stop = await tx.tripStop.findFirst({
      where: {
        tripId: order.tripId,
        deliveryOrderId: order.id,
        status: { in: [...TRIP_STOP_OPEN_STATUSES] },
      },
    });
    if (stop) {
      await tx.tripStop.update({
        where: { id: stop.id },
        data: { status: 'done', arrivedAt: stop.arrivedAt ?? ctx.now, departedAt: ctx.now },
      });
      ctx.emit(
        LOGISTICS_EVENTS.trip.stopCompleted,
        {
          tripId: order.tripId,
          stopId: stop.id,
          deliveryOrderId: order.id,
          complete: summary.complete,
        },
        { ...eventOptions, objectType: LOGISTICS_OBJECT_TYPES.tripStop, objectId: stop.id }
      );
    }
  }
  // Re-planning work of Logística for this order is done once it is delivered.
  await closeOpenWorkItems(
    ctx,
    { objectType: ORDER, objectId: order.id, kinds: ['action'], areaKey: 'logistica' },
    { status: 'done', result: { resolution: status } }
  );

  let childDeliveryOrderId: string | null = null;
  let incidentId: string | null = null;
  if (summary.complete) {
    ctx.emit(
      OPS_EVENTS.delivery.confirmed,
      {
        deliveryOrderId: order.id,
        receivedBy: input.receivedBy,
        lines: deliveredLines,
        zohoWriteQueued,
      },
      { ...eventOptions, objectType: ORDER, objectId: order.id }
    );
  } else {
    const child = await tx.deliveryOrder.create({
      data: {
        caseId: order.caseId,
        allocationIds: summary.shortAllocationIds,
        mode: order.mode,
        status: 'pending',
        carrier: order.mode === 'carrier' ? order.carrier : null,
        addressLine: order.addressLine,
        city: order.city,
        state: order.state,
        postalCode: order.postalCode,
        contactName: order.contactName,
        contactPhone: order.contactPhone,
        lat: order.lat,
        lng: order.lng,
        parentDeliveryOrderId: order.id,
        zohoSyncState: 'not_required',
      },
    });
    childDeliveryOrderId = child.id;
    await ctx.relate(deliveryRef(order.id), deliveryRef(child.id), 'remainder');
    await ctx.relate(
      { type: LOGISTICS_OBJECT_TYPES.case, id: order.caseId },
      deliveryRef(child.id),
      'has_delivery'
    );
    const shortLines = deliveredLines.filter((l) => l.shortQty > QUANTITY_EPSILON);
    ctx.emit(
      OPS_EVENTS.delivery.partial,
      {
        deliveryOrderId: order.id,
        childDeliveryOrderId: child.id,
        receivedBy: input.receivedBy,
        partialReason: input.partialReason ?? null,
        lines: deliveredLines,
        zohoWriteQueued,
      },
      { ...eventOptions, objectType: ORDER, objectId: order.id }
    );
    const ref = await caseReference(tx, order.caseId);
    const { incident } = await ctx.openIncident({
      kind: 'partial_delivery',
      areaKey: 'logistica',
      severity: 'low',
      title: `Entrega parcial de ${ref}`,
      dedupeKey: `partial_delivery:${order.id}`,
      caseId: order.caseId,
      detail: {
        deliveryOrderId: order.id,
        childDeliveryOrderId: child.id,
        receivedBy: input.receivedBy,
        partialReason: input.partialReason ?? null,
        shortLines,
      },
    });
    incidentId = incident.id;
    await ctx.createWorkItem({
      areaKey: 'ventas',
      kind: 'action',
      title: `Decidir remanente de ${ref}`,
      description:
        `Se entregó ${summary.totalDelivered} y faltan ${summary.totalShort}` +
        `${input.partialReason ? ` (motivo: ${input.partialReason})` : ''}. ` +
        'Decide con el cliente si se reprograma el remanente o se ajusta la orden y el paquete en Zoho.',
      caseId: order.caseId,
      objectType: ORDER,
      objectId: child.id,
    });
    publishDeliveryChange(ctx, child);
  }

  for (const listener of [...deliveryListeners()]) {
    await listener(tx, { deliveryOrder: updated, summary, childDeliveryOrderId, ctx });
  }

  publishDeliveryChange(ctx, updated);
  return {
    deliveryOrderId: order.id,
    status,
    complete: summary.complete,
    childDeliveryOrderId,
    zohoSyncState,
    zohoWriteQueued,
    totalDelivered: summary.totalDelivered,
    totalShort: summary.totalShort,
    incidentId,
  };
}

// ---------------------------------------------------------------------------
// cancelDeliveryOrder
// ---------------------------------------------------------------------------

export interface CancelDeliveryOrderResult {
  deliveryOrderId: string;
  status: 'cancelled';
  alreadyCancelled: boolean;
  zohoCancelQueued: boolean;
}

const UNIK_SHIPMENT_STATES = ['pending_write', 'written', 'readback_ok', 'readback_mismatch'];

export async function cancelDeliveryOrder(
  tx: Tx,
  input: CancelDeliveryOrderInput
): Promise<CancelDeliveryOrderResult> {
  const ctx = requireCommandContext(tx);
  const order = await loadDeliveryOrder(tx, input.deliveryOrderId);
  if (order.status === 'cancelled') {
    return {
      deliveryOrderId: order.id,
      status: 'cancelled',
      alreadyCancelled: true,
      zohoCancelQueued: false,
    };
  }
  if (order.status === 'delivered' || order.status === 'partially_delivered') {
    throw new OperationsError('invalid_state', 'Una entrega ya realizada no se puede cancelar');
  }

  // Only shipment orders UNIK wrote (or tried to write) are compensated in Zoho.
  const wroteShipment =
    Boolean(order.packageId) &&
    (UNIK_SHIPMENT_STATES.includes(order.zohoSyncState) ||
      (order.zohoSyncState === 'failed' && readShipmentInput(order.shipmentInput) !== null));
  let zohoSyncState = order.zohoSyncState;
  let zohoCancelQueued = false;
  if (wroteShipment) {
    const transition = transitionZohoSync(order.zohoSyncState, 'cancel_requested');
    if (transition.ok) {
      zohoSyncState = transition.state;
      zohoCancelQueued = true;
      const writeInFlight =
        order.zohoSyncState === 'pending_write' || order.zohoSyncState === 'written';
      ctx.outbox({
        type: LOGISTICS_JOB_TYPES.cancelShipment,
        payload: { deliveryOrderId: order.id, requestedByUserId: actorUserId(ctx) },
        dedupeKey: zohoCancelKey(order.id),
        groupKey: `case:${order.caseId}`,
        maxAttempts: LOGISTICS_ZOHO_MAX_ATTEMPTS,
        priority: JOB_PRIORITY.normal,
        runAt: writeInFlight ? new Date(ctx.now.getTime() + 60_000) : undefined,
        createdBy: actorUserId(ctx) ?? undefined,
      });
    }
  }

  const updated = await tx.deliveryOrder.update({
    where: { id: order.id },
    data: { status: 'cancelled', tripId: null, zohoSyncState, zohoError: null },
  });
  if (order.tripId) {
    const stops = await tx.tripStop.findMany({
      where: {
        tripId: order.tripId,
        deliveryOrderId: order.id,
        status: { in: [...TRIP_STOP_OPEN_STATUSES] },
      },
    });
    for (const stop of stops) {
      await tx.tripStop.update({
        where: { id: stop.id },
        data: { status: 'failed', departedAt: ctx.now },
      });
      ctx.emit(
        LOGISTICS_EVENTS.trip.stopFailed,
        { tripId: order.tripId, stopId: stop.id, deliveryOrderId: order.id, reason: 'cancelled' },
        {
          caseId: order.caseId,
          areaKey: 'logistica',
          objectType: LOGISTICS_OBJECT_TYPES.tripStop,
          objectId: stop.id,
        }
      );
    }
  }
  await closeOpenAreaRequests(
    ctx,
    { objectType: ORDER, objectId: order.id },
    { status: 'cancelled', answer: { reason: input.reason } }
  );
  await closeOpenWorkItems(
    ctx,
    { objectType: ORDER, objectId: order.id },
    { status: 'cancelled', result: { reason: input.reason } }
  );
  ctx.emit(
    LOGISTICS_EVENTS.delivery.cancelled,
    {
      deliveryOrderId: order.id,
      reason: input.reason,
      zohoCancelQueued,
      previousStatus: order.status,
    },
    { caseId: order.caseId, areaKey: 'logistica', objectType: ORDER, objectId: order.id }
  );
  publishDeliveryChange(ctx, { ...updated, tripId: order.tripId });
  return {
    deliveryOrderId: order.id,
    status: 'cancelled',
    alreadyCancelled: false,
    zohoCancelQueued,
  };
}
