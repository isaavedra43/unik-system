import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import type { AreaRowDetail, AreaRowField, AreaWorkRow } from '@/modules/areas/area-work-row';
import {
  extraBoolean,
  extraNumber,
  extraString,
  markSensitive,
} from '@/modules/areas/area-work-row';
import { getOpportunityDetail } from '@/modules/crm/crm-queries';
import { isCrmError } from '@/modules/crm/crm-helpers';
import { formatMoney, formatProbability, VENTAS_ROW_KINDS } from './ventas-constants';

/**
 * Detalle de las filas propias de Ventas (plan 7.4). El núcleo resuelve solo
 * los work items y las solicitudes; aquí sólo se describen expediente,
 * oportunidad y cotización.
 *
 * El expediente y su cronología los agrega el servicio con la regla del
 * expediente (`authorizeOperationsChannel('case')`), así que aquí nunca se leen
 * eventos.
 */

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Mexico_City',
};

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
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

function caseFields(row: AreaWorkRow): AreaRowField[] {
  return compact([
    field('Expediente', row.caseNumber),
    field('Orden de venta', extraString(row.extra, 'salesOrderNumber')),
    field('Cliente', row.customerName),
    field('Estado', row.statusLabel),
    field('Fase', extraString(row.extra, 'phase')),
    field('Prometido', formatDate(row.dueAt)),
    field('Vendedor', extraString(row.extra, 'salespersonName')),
    field('Ubicación', row.locationCode),
    field('Prioridad', row.priority === 'normal' ? null : row.priorityLabel),
    field('Motivo de cierre', extraString(row.extra, 'closeReason')),
    field('Última actividad', formatDate(row.lastActivityAt)),
  ]);
}

function quoteFields(row: AreaWorkRow): AreaRowField[] {
  const convertible = extraBoolean(row.extra, 'convertible');
  return compact([
    field('Folio', extraString(row.extra, 'estimateNumber')),
    field('Estado', row.statusLabel),
    field('Cliente', row.customerName),
    markSensitive(
      field('Total', formatMoney(row.amount, extraString(row.extra, 'currency') ?? 'MXN')),
      'amount'
    ),
    field('Vence', formatDate(row.dueAt)),
    field('Vista por el cliente', extraBoolean(row.extra, 'viewedByClient') ? 'Sí' : 'Todavía no'),
    field('Aceptada', formatDate(extraString(row.extra, 'acceptedDate'))),
    field('Vendedor', extraString(row.extra, 'salespersonName')),
    field(
      'Orden de venta',
      convertible
        ? 'Pendiente: se puede crear en Zoho desde la oportunidad'
        : row.status === 'accepted'
          ? 'Ya se convirtió en orden de venta'
          : null
    ),
  ]);
}

function opportunityFallbackFields(row: AreaWorkRow): AreaRowField[] {
  return compact([
    field('Folio', extraString(row.extra, 'number')),
    field('Estado', row.statusLabel),
    field('Etapa', extraString(row.extra, 'stageName')),
    field('Cliente', row.customerName),
    field('Vendedor', row.ownerName),
    markSensitive(
      field('Valor estimado', formatMoney(row.amount, extraString(row.extra, 'currency') ?? 'MXN')),
      'amount'
    ),
    field('Probabilidad', formatProbability(extraNumber(row.extra, 'probability'))),
    field('Siguiente acción', extraString(row.extra, 'nextActionText'), formatDate(row.dueAt)),
    field('Motivo de la pérdida', extraString(row.extra, 'lostReason')),
    field('Última actividad', formatDate(row.lastActivityAt)),
  ]);
}

/**
 * Oportunidad con sus enlaces reales (cotizaciones, órdenes y expedientes)
 * cuando la persona puede ver el CRM; si sólo tiene `sales_orders.view` se
 * describe con lo que ya trae la fila, sin consultar de más.
 */
async function opportunityFields(actor: CurrentUser, row: AreaWorkRow): Promise<AreaRowField[]> {
  if (!hasPermission(actor, 'crm.view')) return opportunityFallbackFields(row);
  try {
    const detail = await getOpportunityDetail(actor, row.sourceId);
    const opportunity = detail.opportunity;
    const lastActivity = detail.activities.items[0] ?? null;
    return compact([
      field('Folio', opportunity.number),
      field('Estado', opportunity.statusLabel),
      field(
        'Etapa',
        opportunity.stageName,
        opportunity.stageSlaExceededHours !== null
          ? `${opportunity.stageSlaExceededHours} h por encima del SLA de la etapa`
          : null
      ),
      field('Cliente', opportunity.contactName),
      field('Vendedor', opportunity.salespersonName),
      markSensitive(
        field('Valor estimado', formatMoney(opportunity.estimatedValue, opportunity.currency)),
        'amount'
      ),
      field('Probabilidad', formatProbability(opportunity.effectiveProbability)),
      field(
        'Siguiente acción',
        opportunity.nextActionText,
        opportunity.nextActionAt
          ? `${opportunity.nextActionOverdue ? 'Vencida el ' : 'Para el '}${formatDate(opportunity.nextActionAt)}`
          : null
      ),
      field('Cierre estimado', formatDate(opportunity.expectedCloseAt)),
      field(
        'Cotizaciones',
        detail.quotes.length > 0
          ? `${detail.quotes.length}${detail.quotes.some((quote) => quote.convertible) ? ' · una aceptada por convertir' : ''}`
          : null
      ),
      field(
        'Órdenes de venta',
        detail.salesOrders.length > 0 ? String(detail.salesOrders.length) : null
      ),
      field(
        'Expedientes',
        detail.cases.length > 0 ? detail.cases.map((item) => item.caseNumber).join(', ') : null
      ),
      field(
        'Conversaciones',
        detail.conversations.length > 0 ? String(detail.conversations.length) : null
      ),
      field('Motivo de la pérdida', opportunity.lostReason),
      field(
        'Última actividad',
        lastActivity ? `${lastActivity.kindLabel}: ${lastActivity.summary}` : null,
        formatDate(opportunity.lastActivityAt)
      ),
    ]);
  } catch (error) {
    if (isCrmError(error)) return opportunityFallbackFields(row);
    throw error;
  }
}

/** Parte del detalle que aporta Ventas; el resto lo completa `work-rows-service`. */
export async function getVentasRowDetail(
  actor: CurrentUser,
  row: AreaWorkRow
): Promise<Partial<AreaRowDetail> | null> {
  if (row.rowKind === VENTAS_ROW_KINDS.case) return { fields: caseFields(row) };
  if (row.rowKind === VENTAS_ROW_KINDS.quote) return { fields: quoteFields(row) };
  if (row.rowKind === VENTAS_ROW_KINDS.opportunity) {
    return { fields: await opportunityFields(actor, row) };
  }
  return null;
}
