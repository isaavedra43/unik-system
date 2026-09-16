import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { AreaRowDetail, AreaWorkRow, AreaRowField } from '@/modules/areas/area-work-row';
import { extraNumber, extraString } from '@/modules/areas/area-work-row';
import { getLegacyClaimDetail } from '@/modules/areas/inventario/inventory-area-queries';
import { getStockCountDetail } from '@/modules/inventory/inventory-queries';
import { qty } from '@/modules/inventory/inventory-dto';
import { toAvailabilityDTO, verifyAvailability } from '@/modules/inventory/inventory-service';
import {
  CONFIDENCE_LABELS,
  COUNT_LINE_RESOLUTION_LABELS,
  LEGACY_CLAIM_SOURCE_LABELS,
  LEGACY_CLAIM_STATUS_LABELS,
  MOVEMENT_KIND_LABELS,
  RESERVATION_STATUS_LABELS,
  toConfidenceLevel,
} from '@/modules/inventory/inventory-types';
import { describeVariant } from '@/modules/inventory/variant-key';
import { getWorkItem } from '@/modules/operations/work-items-service';

/**
 * Detail of the Inventario rows the core does not know (plan 7.4): a
 * verification, a count, a reservation and a movement.
 *
 * It only returns the parts it knows — facts, evidence and where new evidence
 * goes; the service adds the case timeline and the case summary, and only for
 * somebody the case rule lets in.
 */

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Mexico_City',
};

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('es-MX', DATE_FORMAT).format(date);
  } catch {
    return date.toISOString();
  }
}

function field(
  label: string,
  value: string | number | null | undefined,
  hint?: string | null
): AreaRowField | null {
  const text = typeof value === 'number' ? String(value) : (value ?? '').toString().trim();
  return text ? { label, value: text, hint: hint ?? null } : null;
}

function compact(fields: Array<AreaRowField | null>): AreaRowField[] {
  return fields.filter((entry): entry is AreaRowField => entry !== null);
}

function quantityText(value: unknown, unit: string | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (!text) return '';
  return unit ? `${text} ${unit}` : text;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function verificationDetail(
  actor: CurrentUser,
  row: AreaWorkRow,
  now: Date
): Promise<Partial<AreaRowDetail>> {
  const item = await getWorkItem(actor, row.sourceId, { now });
  const zohoItemId = extraString(row.extra, 'zohoItemId');
  const unit = extraString(row.extra, 'unit');
  const quantity = row.quantity;

  let availabilityFields: AreaRowField[] = [];
  if (zohoItemId) {
    try {
      const availability = toAvailabilityDTO(
        await verifyAvailability(prisma, {
          zohoItemId,
          quantityBase: quantity ?? 0,
        })
      );
      availabilityFields = compact([
        field(
          'Confianza del artículo',
          availability.confidenceLabel,
          availability.requiresCount
            ? 'Necesita un conteo puntual antes de poder prometerse.'
            : 'Se puede prometer con lo que hay.'
        ),
        field('Disponible', quantityText(availability.available, availability.baseUnit)),
        field('Conocido', quantityText(availability.known, availability.baseUnit)),
        field('Reservado', quantityText(availability.reserved, availability.baseUnit)),
        Number(availability.shortfall) > 0
          ? field('Faltante', quantityText(availability.shortfall, availability.baseUnit))
          : null,
        field('Última verificación', formatDate(availability.lastVerifiedAt)),
        availability.zoho
          ? field(
              'Zoho (informativo)',
              quantityText(availability.zoho.availableStock, availability.baseUnit),
              'Cifra de Zoho; nunca entra en las fórmulas del inventario.'
            )
          : null,
      ]);
    } catch (error) {
      console.error(
        JSON.stringify({
          component: 'inventario-row-detail',
          event: 'availability_failed',
          zohoItemId,
          message: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }

  return {
    fields: compact([
      field('Tipo de trabajo', item.kindLabel),
      field('Estado', item.statusLabel),
      field('Responsable', item.ownerName),
      field('Suplente', item.backupName),
      field('Vence', formatDate(item.dueAt)),
      field('Expediente', item.caseNumber),
      field('Cliente', item.customerName),
      field('Artículo', extraString(row.extra, 'productName')),
      field('SKU', extraString(row.extra, 'sku')),
      field('Cantidad pedida', quantityText(quantity, unit)),
      field(
        'Motivo de la espera',
        item.waitReason,
        item.waitUntil ? `Hasta ${formatDate(item.waitUntil)}` : null
      ),
      field('Descripción', item.description),
      item.escalationLevel > 0 ? field('Escalación', `Nivel ${item.escalationLevel}`) : null,
      ...availabilityFields,
    ]),
    evidence: item.evidence.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      label: entry.kindLabel,
      note: entry.note,
      createdAt: entry.createdAt,
      createdByName: entry.createdByName,
      storageObjectId: entry.file?.objectId ?? null,
    })),
    missingEvidence: item.missingEvidence,
    evidenceTargetId: `work_item:${item.id}`,
  };
}

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

async function countDetail(actor: CurrentUser, row: AreaWorkRow): Promise<Partial<AreaRowDetail>> {
  const detail = await getStockCountDetail(actor, row.sourceId);
  const pending = detail.lines.filter((line) => line.resolution === 'pending').length;
  const disputed = detail.lines.filter((line) => line.resolution === 'disputed').length;
  const outOfTolerance = detail.lines.filter((line) => !line.withinTolerance).length;
  const sample = detail.lines.slice(0, 5).map((line) => {
    const name = line.productName ?? line.sku ?? line.zohoItemId ?? 'Artículo';
    const place = [line.locationCode, line.variantLabel, line.containerKey]
      .filter(Boolean)
      .join(' · ');
    return field(
      name,
      `Esperado ${line.expectedQty} · contado ${line.countedQty} ${line.unit}`,
      [place, (COUNT_LINE_RESOLUTION_LABELS as Record<string, string>)[line.resolution]]
        .filter(Boolean)
        .join(' · ')
    );
  });

  return {
    fields: compact([
      field('Tipo de conteo', detail.count.scopeLabel),
      field('Estado', detail.count.statusLabel),
      field('Bodega', detail.warehouseName),
      field('Líneas capturadas', detail.lines.length),
      outOfTolerance > 0 ? field('Fuera de tolerancia', outOfTolerance) : null,
      pending > 0 ? field('Esperan autorización', pending) : null,
      disputed > 0 ? field('En disputa', disputed) : null,
      field('Abierto el', formatDate(detail.count.createdAt)),
      field('Cerrado el', detail.count.closedAt ? formatDate(detail.count.closedAt) : null),
      ...sample,
    ]),
    evidenceTargetId: null,
  };
}

// ---------------------------------------------------------------------------
// Reservation
// ---------------------------------------------------------------------------

async function reservationDetail(row: AreaWorkRow): Promise<Partial<AreaRowDetail>> {
  const reservation = await prisma.stockReservation.findUnique({ where: { id: row.sourceId } });
  if (!reservation) return {};
  const [product, profile, stockItem, operationalCase] = await Promise.all([
    prisma.product.findUnique({
      where: { zohoItemId: reservation.zohoItemId },
      select: { name: true, sku: true },
    }),
    prisma.productInventoryProfile.findUnique({
      where: { zohoItemId: reservation.zohoItemId },
      select: { baseUnit: true, confidence: true },
    }),
    prisma.stockItem.findUnique({
      where: { id: reservation.stockItemId },
      select: { variantKey: true, variantJson: true, containerKey: true, locationId: true },
    }),
    prisma.operationalCase.findUnique({
      where: { id: reservation.caseId },
      select: { caseNumber: true, customerName: true, promisedAt: true },
    }),
  ]);
  const location = stockItem
    ? await prisma.storageLocation.findUnique({
        where: { id: stockItem.locationId },
        select: { code: true },
      })
    : null;

  const unit = profile?.baseUnit ?? null;
  const variant = stockItem
    ? describeVariant(
        stockItem.variantKey,
        stockItem.variantJson &&
          typeof stockItem.variantJson === 'object' &&
          !Array.isArray(stockItem.variantJson)
          ? (stockItem.variantJson as Record<string, unknown>)
          : null
      )
    : '';

  return {
    fields: compact([
      field('Artículo', product?.name ?? product?.sku ?? reservation.zohoItemId),
      field('SKU', product?.sku),
      field('Estado', (RESERVATION_STATUS_LABELS as Record<string, string>)[reservation.status]),
      field('Cantidad reservada', quantityText(qty(reservation.quantity), unit)),
      field('Variante', variant),
      field('Contenedor', stockItem?.containerKey),
      field('Ubicación', location?.code),
      field('Expediente', operationalCase?.caseNumber),
      field('Cliente', operationalCase?.customerName),
      field(
        'Prometido al cliente',
        operationalCase?.promisedAt ? formatDate(operationalCase.promisedAt) : null
      ),
      field('Reservada el', formatDate(reservation.createdAt)),
      field('Vence', reservation.expiresAt ? formatDate(reservation.expiresAt) : null),
      field(
        'Confianza al reservar',
        CONFIDENCE_LABELS[toConfidenceLevel(reservation.confidenceAtReserve)],
        CONFIDENCE_LABELS[toConfidenceLevel(profile?.confidence)] !==
          CONFIDENCE_LABELS[toConfidenceLevel(reservation.confidenceAtReserve)]
          ? `Hoy el artículo está ${CONFIDENCE_LABELS[toConfidenceLevel(profile?.confidence)].toLowerCase()}.`
          : null
      ),
    ]),
    evidenceTargetId: null,
  };
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

async function movementDetail(row: AreaWorkRow): Promise<Partial<AreaRowDetail>> {
  const movement = await prisma.stockMovement.findUnique({ where: { id: row.sourceId } });
  if (!movement) return {};
  const [product, profile, stockItem, actor] = await Promise.all([
    prisma.product.findUnique({
      where: { zohoItemId: movement.zohoItemId },
      select: { name: true, sku: true },
    }),
    prisma.productInventoryProfile.findUnique({
      where: { zohoItemId: movement.zohoItemId },
      select: { baseUnit: true },
    }),
    prisma.stockItem.findUnique({
      where: { id: movement.stockItemId },
      select: { variantKey: true, variantJson: true, containerKey: true, locationId: true },
    }),
    prisma.user.findUnique({ where: { id: movement.actorId }, select: { name: true } }),
  ]);
  const location = stockItem
    ? await prisma.storageLocation.findUnique({
        where: { id: stockItem.locationId },
        select: { code: true },
      })
    : null;

  return {
    fields: compact([
      field('Movimiento', (MOVEMENT_KIND_LABELS as Record<string, string>)[movement.kind]),
      field('Artículo', product?.name ?? product?.sku ?? movement.zohoItemId),
      field('SKU', product?.sku),
      field(
        'Cantidad',
        quantityText(qty(movement.quantity), profile?.baseUnit ?? null),
        movement.originalUnit && movement.originalUnit !== profile?.baseUnit
          ? `Capturado como ${qty(movement.originalQuantity)} ${movement.originalUnit}`
          : null
      ),
      field('Ubicación', location?.code),
      field('Contenedor', stockItem?.containerKey),
      field('Registrado por', actor?.name),
      field('Ocurrió el', formatDate(movement.occurredAt)),
      field(
        'Referencia',
        movement.referenceType
          ? `${movement.referenceType}${movement.referenceId ? ` · ${movement.referenceId}` : ''}`
          : null
      ),
      field('Nota', movement.note),
    ]),
    evidenceTargetId: null,
  };
}

// ---------------------------------------------------------------------------
// Legacy claim (compromiso previo al corte)
// ---------------------------------------------------------------------------

async function legacyClaimDetail(
  actor: CurrentUser,
  row: AreaWorkRow
): Promise<Partial<AreaRowDetail>> {
  const { claim, demands } = await getLegacyClaimDetail(actor, row.sourceId);
  return {
    fields: compact([
      field('Artículo', claim.productName ?? claim.sku ?? claim.zohoItemId),
      field('SKU', claim.sku),
      field('Cantidad comprometida', quantityText(claim.quantity, claim.unit)),
      field('Bodega', claim.warehouseName),
      field('Estado', (LEGACY_CLAIM_STATUS_LABELS as Record<string, string>)[claim.status]),
      field('Origen', (LEGACY_CLAIM_SOURCE_LABELS as Record<string, string>)[claim.source]),
      field('Referencia', claim.reference),
      field('Variante', describeVariant(claim.variantKey, null)),
      field('Registrado el', formatDate(claim.createdAt)),
      field(
        'Vence',
        formatDate(claim.expiresAt),
        claim.status === 'claimed'
          ? 'Si nadie lo confirma ni lo libera, el supervisor lo expira y la cantidad vuelve al disponible.'
          : null
      ),
      claim.status === 'claimed'
        ? field(
            'Necesidades que podría cubrir',
            demands.length,
            demands.length === 0
              ? 'Ningún expediente abierto pide este artículo todavía.'
              : 'Se elige una al confirmar el compromiso.'
          )
        : null,
    ]),
    evidenceTargetId: null,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Detail of an Inventario row; `null` for a row kind this area does not own. */
export async function getInventoryRowDetail(
  actor: CurrentUser,
  row: AreaWorkRow,
  options: { now: Date }
): Promise<Partial<AreaRowDetail> | null> {
  switch (row.rowKind) {
    case 'verification':
      return verificationDetail(actor, row, options.now);
    case 'stock_count':
      return countDetail(actor, row);
    case 'reservation':
      return reservationDetail(row);
    case 'movement':
      return movementDetail(row);
    case 'legacy_claim':
      return legacyClaimDetail(actor, row);
    default:
      return null;
  }
}

/** Number of lines of a count row, for the copilot context (never throws). */
export function countLinesOf(row: AreaWorkRow): number {
  return extraNumber(row.extra, 'lines') ?? 0;
}
