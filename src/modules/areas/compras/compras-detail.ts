import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import {
  getProcurementOrder,
  getPurchaseRequest,
  getRfq,
  getSupplier,
} from '@/modules/purchases/purchases-queries';
import { PURCHASES_OBJECT_TYPES } from '@/modules/purchases/purchases-types';
import { markSensitive } from '../area-work-row';
import type { AreaRowDetail, AreaRowEvidence, AreaRowField, AreaWorkRow } from '../area-work-row';
import type { AreaServerOptions } from '../area-server-registry';
import {
  formatLeadTime,
  formatMoney,
  formatQty,
  formatScore,
  orderNextAction,
  responseNeedsReview,
} from './compras-model';

/**
 * Detail of the Compras rows (plan 7.4): the facts of a request, an RFQ, an
 * order, a receipt or a supplier, ready for the drawer and the detail page.
 *
 * The service adds the case timeline and the case summary on top, and only for
 * somebody the case rule lets in; this file never reads a case.
 *
 * Every read goes through `purchases-queries`, which checks the purchases
 * permissions again. Somebody who can open the area but not Compras (an
 * operations admin without `purchases.view`) gets the base facts of the row
 * instead of an error: `null` means "I have nothing to add".
 */

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Mexico_City',
};

function formatDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('es-MX', DATE_FORMAT).format(date);
  } catch {
    return date.toISOString();
  }
}

function field(
  label: string,
  value: string | null | undefined,
  hint?: string | null
): AreaRowField | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? { label, value: text, hint: hint ?? null } : null;
}

function compact(fields: Array<AreaRowField | null>): AreaRowField[] {
  return fields.filter((entry): entry is AreaRowField => entry !== null);
}

function count(value: number, singular: string, plural: string): string {
  return `${value.toLocaleString('es-MX')} ${value === 1 ? singular : plural}`;
}

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'areas-compras-detail', event, ...extra }));

// ---------------------------------------------------------------------------
// Evidence of an order (receipt photos, signatures and the order PDF)
// ---------------------------------------------------------------------------

async function orderEvidence(orderId: string): Promise<AreaRowEvidence[]> {
  const links = await prisma.evidenceLink.findMany({
    where: { objectType: PURCHASES_OBJECT_TYPES.order, objectId: orderId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      kind: true,
      note: true,
      createdAt: true,
      createdBy: true,
      storageObjectId: true,
    },
  });
  if (links.length === 0) return [];
  const authors = await prisma.user.findMany({
    where: { id: { in: [...new Set(links.map((link) => link.createdBy))] } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(authors.map((author) => [author.id, author.name]));
  const kindLabels: Record<string, string> = {
    photo: 'Foto',
    signature: 'Firma',
    document: 'Documento',
    note: 'Nota',
    count: 'Conteo',
    zoho_readback: 'Relectura de Zoho',
  };
  return links.map((link) => ({
    id: link.id,
    kind: link.kind,
    label: kindLabels[link.kind] ?? 'Evidencia',
    note: link.note,
    createdAt: link.createdAt.toISOString(),
    createdByName: nameOf.get(link.createdBy) ?? null,
    storageObjectId: link.storageObjectId,
  }));
}

// ---------------------------------------------------------------------------
// One detail per row kind
// ---------------------------------------------------------------------------

async function purchaseRequestDetail(
  actor: CurrentUser,
  row: AreaWorkRow
): Promise<Partial<AreaRowDetail>> {
  const request = await getPurchaseRequest(actor, row.sourceId);
  const openLines = request.lines.filter((line) => line.status === 'open').length;
  return {
    fields: compact([
      field('Folio', request.number),
      field('Estado', request.statusLabel),
      field('Solicitó', request.requestedByName),
      field('Área que pide', request.areaKey),
      field('Necesario para', formatDate(request.neededBy)),
      field(
        'Partidas',
        count(request.lines.length, 'partida', 'partidas'),
        openLines > 0 ? `${openLines} sin ordenar` : 'Todas ordenadas'
      ),
      field('Expediente', request.caseNumber),
      field(
        'Cotizaciones',
        request.rfqs.length > 0 ? request.rfqs.map((rfq) => rfq.number).join(', ') : null
      ),
      field(
        'Órdenes de compra',
        request.orders.length > 0 ? request.orders.map((order) => order.number).join(', ') : null
      ),
      ...request.lines
        .slice(0, 8)
        .map((line) =>
          field(
            line.description.slice(0, 60),
            `${formatQty(line.qty, line.unit)} · ${line.statusLabel}`,
            Number(line.qtyOrdered) > 0 ? `${formatQty(line.qtyOrdered, line.unit)} ordenado` : null
          )
        ),
    ]),
    // What the person who asked for the purchase wrote, shown as a quote.
    freeText: request.reason,
  };
}

async function rfqDetail(
  actor: CurrentUser,
  row: AreaWorkRow,
  now: Date
): Promise<Partial<AreaRowDetail>> {
  const rfq = await getRfq(actor, row.sourceId, now);
  const best = rfq.comparison.find((entry) => entry.rank === 1) ?? null;
  const toReview = rfq.responses.filter((response) =>
    responseNeedsReview({
      status: response.status,
      confidence: response.confidence,
      reviewReasons: response.reviewReasons,
    })
  ).length;
  const replied = rfq.invitations.filter((invitation) => invitation.status === 'replied').length;
  return {
    fields: compact([
      field('Folio', rfq.number),
      field('Estado', rfq.statusLabel),
      field('Cierra', formatDate(rfq.dueAt)),
      field('Partidas', count(rfq.lines.length, 'partida', 'partidas')),
      field(
        'Invitados',
        count(rfq.invitations.length, 'proveedor', 'proveedores'),
        `${replied} respondieron`
      ),
      field(
        'Respuestas',
        count(rfq.responses.length, 'respuesta', 'respuestas'),
        toReview > 0 ? `${toReview} por revisar` : 'Todas revisadas'
      ),
      best
        ? markSensitive(
            field(
              'Mejor opción',
              `${best.name ?? 'Sin nombre'} · ${formatMoney(best.landedTotal)}`,
              `Puntaje ${formatScore(best.score)}${best.comparable ? '' : ' · no comparable'}`
            ),
            'amount'
          )
        : null,
      best && best.reasons.length > 0
        ? field('Por qué', best.reasons.slice(0, 2).join('; '))
        : null,
    ]),
  };
}

async function procurementOrderDetail(
  actor: CurrentUser,
  row: AreaWorkRow
): Promise<Partial<AreaRowDetail>> {
  const order = await getProcurementOrder(actor, row.sourceId);
  const next = orderNextAction({
    status: order.status,
    paymentMode: order.paymentMode,
    paymentStatus: order.paymentStatus,
    deliveryMode: order.deliveryMode,
    sentToSupplierAt: order.sentToSupplierAt,
    obligationId: order.obligationId,
    openDifferences: order.openIncidents.length,
  });
  const allocations = order.lines.flatMap((line) => line.allocations);
  const cases = [
    ...new Set(allocations.map((allocation) => allocation.caseNumber).filter(Boolean)),
  ];
  const pending = order.lines.reduce(
    (sum, line) => sum + Math.max(0, Number(line.qty) - Number(line.qtyAccepted)),
    0
  );
  return {
    fields: compact([
      field('Folio', order.number),
      field('Proveedor', order.supplierName),
      field('Estado', order.statusLabel),
      field('Siguiente paso', next.id === 'none' ? null : next.label, next.hint),
      markSensitive(
        field(
          'Total',
          formatMoney(order.total, order.currency),
          `Subtotal ${formatMoney(order.subtotal, order.currency)} · IVA ${formatMoney(order.taxTotal, order.currency)}`
        ),
        'amount'
      ),
      field('Pago', `${order.paymentModeLabel} · ${order.paymentStatusLabel}`),
      field('Entrega', order.deliveryModeLabel),
      field('Fecha prometida', formatDate(order.expectedAt)),
      field('Enviada al proveedor', formatDate(order.sentToSupplierAt), order.sentVia ?? null),
      field(
        'Partidas',
        count(order.lines.length, 'partida', 'partidas'),
        pending > 0 ? `${formatQty(pending)} por recibir` : 'Todo recibido'
      ),
      field(
        'Recepciones',
        order.receipts.length > 0 ? count(order.receipts.length, 'recepción', 'recepciones') : null
      ),
      order.approval
        ? field(
            'Aprobación',
            `${order.approval.approvals} de ${order.approval.requiredApprovals} firmas`,
            order.approval.status
          )
        : null,
      order.obligation
        ? markSensitive(
            field(
              'Obligación por pagar',
              `${order.obligation.number} · ${formatMoney(order.obligation.expectedAmount)}`,
              `Liquidado ${formatMoney(order.obligation.settledAmount)}`
            ),
            'amount'
          )
        : null,
      field('Surte a', cases.length > 0 ? cases.join(', ') : null),
      order.openIncidents.length > 0
        ? field(
            'Diferencias abiertas',
            count(order.openIncidents.length, 'diferencia', 'diferencias'),
            order.openIncidents[0]?.title ?? null
          )
        : null,
    ]),
    evidence: await orderEvidence(order.id),
    // Receipt evidence has its own upload target (`purchase_receipt_evidence`),
    // used by the receipt capture; the generic drawer uploader does not apply.
    evidenceTargetId: null,
    freeText: order.notes,
  };
}

async function goodsReceiptDetail(row: AreaWorkRow): Promise<Partial<AreaRowDetail>> {
  const receipt = await prisma.goodsReceipt.findUnique({
    where: { id: row.sourceId },
    include: { lines: true, order: { select: { number: true, currency: true } } },
  });
  if (!receipt) return {};
  const differences = receipt.lines.filter((line) => line.differenceKind !== 'none');
  const accepted = receipt.lines.reduce((sum, line) => sum + Number(line.qtyAccepted), 0);
  const rejected = receipt.lines.reduce((sum, line) => sum + Number(line.qtyRejected), 0);
  return {
    fields: compact([
      field('Folio', receipt.number),
      field('Orden de compra', receipt.order.number),
      field('Recibida', formatDate(receipt.receivedAt)),
      field(
        'Modo',
        receipt.mode === 'direct_delivery' ? 'Entrega directa al cliente' : 'Recepción en bodega'
      ),
      field('Aceptado', formatQty(accepted)),
      field('Rechazado', rejected > 0 ? formatQty(rejected) : null),
      field(
        'Diferencias',
        differences.length > 0
          ? count(differences.length, 'partida', 'partidas')
          : 'Sin diferencias'
      ),
      field('Partidas', count(receipt.lines.length, 'partida', 'partidas')),
    ]),
    freeText: receipt.notes,
  };
}

async function supplierDetail(
  actor: CurrentUser,
  row: AreaWorkRow
): Promise<Partial<AreaRowDetail>> {
  const detail = await getSupplier(actor, row.sourceId);
  const supplier = detail.supplier;
  const lastOrder = detail.recentOrders[0] ?? null;
  return {
    fields: compact([
      field('Folio', supplier.number),
      field('Nombre', supplier.name),
      field('Razón social', supplier.legalName),
      field('RFC', supplier.taxRegNo),
      field('Estado', supplier.statusLabel),
      field(
        'Calificación',
        supplier.rating.overall ? `${supplier.rating.overall} de 5` : null,
        `${supplier.evaluationsCount} evaluaciones`
      ),
      field('Puntualidad', supplier.rating.onTime ? `${supplier.rating.onTime} de 5` : null),
      field('Calidad', supplier.rating.quality ? `${supplier.rating.quality} de 5` : null),
      field(
        'Pago',
        `${supplier.paymentModeLabel}${supplier.paymentTermsDays ? ` · ${supplier.paymentTermsDays} días` : ''}`
      ),
      field('Plazo de entrega', formatLeadTime(supplier.leadTimeDaysDefault)),
      markSensitive(field('Teléfono', supplier.primaryPhone), 'contact'),
      markSensitive(field('Correo', supplier.primaryEmail), 'contact'),
      field('Sitio', supplier.website),
      field('Productos', count(detail.products.length, 'producto', 'productos')),
      field('Órdenes abiertas', detail.openOrders.toLocaleString('es-MX')),
      lastOrder
        ? markSensitive(
            field(
              'Última orden',
              `${lastOrder.number} · ${formatMoney(lastOrder.total, lastOrder.currency)}`,
              lastOrder.statusLabel
            ),
            'amount'
          )
        : null,
      field('Proveedor de Zoho', supplier.zohoContactId ? 'Vinculado' : 'Sin vincular'),
      field('Viene del laboratorio', detail.sourceCandidate ? detail.sourceCandidate.name : null),
    ]),
    freeText: supplier.notes,
  };
}

/**
 * Detail of one Compras row. Returns `null` when the row kind is not ours or
 * when this person may not read Compras: the caller keeps the base facts the
 * table already showed instead of failing.
 */
export async function getComprasRowDetail(
  actor: CurrentUser,
  row: AreaWorkRow,
  options: AreaServerOptions
): Promise<Partial<AreaRowDetail> | null> {
  try {
    switch (row.rowKind) {
      case 'purchase_request':
        return await purchaseRequestDetail(actor, row);
      case 'rfq':
        return await rfqDetail(actor, row, options.now);
      case 'procurement_order':
        return await procurementOrderDetail(actor, row);
      case 'goods_receipt':
        return await goodsReceiptDetail(row);
      case 'supplier':
        return await supplierDetail(actor, row);
      default:
        return null;
    }
  } catch (error) {
    log('row_detail_failed', {
      rowKind: row.rowKind,
      rowId: row.id,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
