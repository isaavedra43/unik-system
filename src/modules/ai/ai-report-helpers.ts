/**
 * Pure helpers that shape report artifacts (title subtitle, KPI cards) from a data tool's
 * result. Kept free of Prisma/LLM imports so they can be unit tested directly.
 */

export const DATE_RANGE_LABELS: Record<string, string> = {
  today: 'Hoy',
  yesterday: 'Ayer',
  this_week: 'Esta semana',
  this_month: 'Este mes',
  last_month: 'Mes pasado',
  last_7_days: 'Últimos 7 días',
  last_30_days: 'Últimos 30 días',
  this_year: 'Este año',
  last_year: 'Año pasado',
  all: 'Todo el historial',
};

/**
 * Parses a numeric value that may arrive as a number, a Prisma Decimal string ("1797.00") or
 * an already-formatted amount the model typed itself ("$1,797.00 MXN", "1.797,00"). Returns
 * null when the text has no usable number — callers then print the original text instead of
 * "$NaN", which is what the report image used to show for hand-typed totals.
 */
export function parseNumeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  if (!raw) return null;
  const direct = Number(raw);
  if (Number.isFinite(direct)) return direct;
  // Strip currency symbols, codes, spaces and thousands separators.
  let s = raw.replace(/[^\d.,\-()]/g, '');
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()\-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    // "1.797,00" — European style: dot thousands, comma decimals.
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    // "1,797.00" — comma thousands.
    s = s.replace(/,/g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Sum of a numeric-like column across rows; null when no row has a usable number. */
export function sumColumn(rows: Array<Record<string, unknown>>, key: string): number | null {
  let sum = 0;
  let any = false;
  for (const row of rows) {
    const n = parseNumeric(row[key]);
    if (n !== null) {
      sum += n;
      any = true;
    }
  }
  return any ? sum : null;
}

/** One line under the title that says exactly what period and filters the numbers cover. */
export function buildReportSubtitle(
  toolArgs: Record<string, unknown> | null,
  lastResult: Record<string, unknown> | null
): string | undefined {
  if (!toolArgs) return undefined;
  const parts: string[] = [];
  const dateRange = toolArgs.dateRange as string | undefined;
  const dateFrom = toolArgs.dateFrom as string | undefined;
  const dateTo = toolArgs.dateTo as string | undefined;
  if (dateFrom || dateTo) parts.push(`Periodo: ${dateFrom ?? '…'} a ${dateTo ?? '…'}`);
  else if (dateRange && DATE_RANGE_LABELS[dateRange]) parts.push(`Periodo: ${DATE_RANGE_LABELS[dateRange]}`);

  const filterLabels: Array<[string, string]> = [
    ['ticketStatus', 'Estado'],
    ['shippedStatus', 'Envío'],
    ['paidStatus', 'Pago'],
    ['invoicedStatus', 'Facturación'],
    ['status', 'Estado Zoho'],
    ['deliveryMethod', 'Entrega'],
    ['deliveryType', 'Tipo de entrega'],
    ['shippingLocation', 'Lugar'],
    ['customer', 'Cliente'],
    ['salesperson', 'Vendedor'],
    ['product', 'Producto'],
    ['location', 'Sucursal'],
  ];
  const filters: string[] = [];
  for (const [key, label] of filterLabels) {
    const v = toolArgs[key];
    if (typeof v === 'string' && v.trim()) filters.push(`${label}: ${v}`);
  }
  const pm = toolArgs.paymentMethods;
  if (Array.isArray(pm) && pm.length > 0) filters.push(`Pago con: ${pm.join(', ')}`);
  if (filters.length > 0) parts.push(`Filtros — ${filters.join(' · ')}`);

  const recon = lastResult?.statusReconciliation as Record<string, unknown> | undefined;
  if (recon && typeof recon.totalWithoutStatusFilters === 'number' && typeof recon.matched === 'number') {
    parts.push(`${recon.matched} de ${recon.totalWithoutStatusFilters} órdenes del periodo`);
  }
  parts.push(`Generado ${new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })}`);
  return parts.join('  ·  ');
}

export function money(v: unknown): string {
  const n = parseNumeric(v);
  if (n === null) return v === null || v === undefined ? '$0.00' : String(v);
  return `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * KPI cards for a report, from the last data tool's scalar fields. Counts and amounts are
 * kept apart on purpose: querySalesOrders' list mode returns `total` = NUMBER OF ORDERS and
 * `totalSum` = money — the old generic mapping printed the order count as "$55.00".
 */
export function buildSummaryCards(result: Record<string, unknown>): Array<{ label: string; value: string }> {
  const cards: Array<{ label: string; value: string }> = [];
  const has = (k: string) => result[k] !== undefined && result[k] !== null && result[k] !== '';

  if (result.mode === 'list' && has('totalSum')) {
    if (has('total')) cards.push({ label: 'Órdenes', value: String(result.total) });
    cards.push({ label: 'Total', value: money(result.totalSum) });
    if (has('balanceSum') && Number(result.balanceSum) > 0) cards.push({ label: 'Saldo pendiente', value: money(result.balanceSum) });
    return cards;
  }
  if (result.mode === 'grouped' && has('totalRevenue')) {
    if (has('totalOrders')) cards.push({ label: 'Órdenes', value: String(result.totalOrders) });
    if (has('groupCount')) cards.push({ label: 'Grupos', value: String(result.groupCount) });
    cards.push({ label: 'Total', value: money(result.totalRevenue) });
    if (has('totalBalance') && Number(result.totalBalance) > 0) cards.push({ label: 'Saldo pendiente', value: money(result.totalBalance) });
    return cards.slice(0, 4);
  }

  // Generic tools: money-like keys are amounts, count-like keys are counts.
  const amountKeys: Array<[string, string]> = [['totalRevenue', 'Total'], ['totalSum', 'Total'], ['totalAmount', 'Total'], ['totalBalance', 'Saldo'], ['balanceSum', 'Saldo'], ['pendingBalance', 'Saldo pendiente']];
  const countKeys: Array<[string, string]> = [['totalOrders', 'Órdenes'], ['count', 'Registros'], ['pendingOrders', 'Pendientes'], ['totalQuantity', 'Cantidad']];
  for (const [k, label] of countKeys) if (has(k) && !cards.some((c) => c.label === label)) cards.push({ label, value: String(result[k]) });
  for (const [k, label] of amountKeys) if (has(k) && !cards.some((c) => c.label === label)) cards.push({ label, value: money(result[k]) });
  return cards.slice(0, 4);
}

