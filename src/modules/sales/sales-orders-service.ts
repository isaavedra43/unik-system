import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { SALES_ORDER_COLUMNS, SALES_ORDER_COLUMN_MAP } from './sales-orders-columns';
import {
  salesOrderQueryStateSchema,
  FILTER_OPERATORS_BY_TYPE,
  SalesOrderFilterGroup,
  SalesOrderFilterRule,
  SalesOrderQueryState,
  SalesOrderSort,
  DATE_SHORTCUTS,
} from './sales-orders-filters';
import { toSalesOrderListRow, toSalesOrderDetail } from './sales-orders-contract';
import type { SalesOrderListRow, SalesOrderDetail } from './sales-orders-contract';
import {
  formatCurrency,
  formatDateOnly,
  getSalesOrderStatusConfig,
  getTicketStatus,
} from './sales-orders-helpers';

const MIN_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_EXPORT_ROWS = 50_000;

/**
 * @deprecated Use salesOrderQueryStateSchema instead. Kept for backward compat
 * with any existing API route consumers.
 */
const legacySalesOrderListQuerySchema = z.object({
  page: z.coerce.number().int().min(MIN_PAGE).default(MIN_PAGE),
  page_size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  date_from: z.coerce.date().optional(),
  date_to: z.coerce.date().optional(),
  status: z.string().optional(),
  salesperson: z.string().optional(),
  payment_method: z.string().optional(),
  delivery_method: z.string().optional(),
  location: z.string().optional(),
  search: z.string().optional(),
});

type LegacySalesOrderListQuery = z.output<typeof legacySalesOrderListQuerySchema>;

export type { SalesOrderListRow, SalesOrderDetail };

const LIST_SELECT = {
  id: true,
  zohoSalesOrderId: true,
  salesOrderNumber: true,
  referenceNumber: true,
  orderDate: true,
  customerName: true,
  customerPhone: true,
  salespersonName: true,
  paymentMethod: true,
  deliveryMethod: true,
  locationName: true,
  branchName: true,
  status: true,
  subStatus: true,
  paidStatus: true,
  invoicedStatus: true,
  shippedStatus: true,
  currencyCode: true,
  subtotal: true,
  discountTotal: true,
  taxTotal: true,
  shippingCharge: true,
  adjustment: true,
  total: true,
  balance: true,
  saleMadeInWarehouse: true,
  sourceRemoteModifiedAt: true,
  shippingAddressLine1: true,
  shippingAddressLine2: true,
} satisfies Prisma.SalesOrderSelect;

// ---------------------------------------------------------------------------
// Filter → Prisma where
// ---------------------------------------------------------------------------

type W = Prisma.SalesOrderWhereInput;

/** Matches nothing — used when a filter has a value but no row can satisfy it. */
const MATCH_NONE: W = { id: { in: [] } };

const BUSINESS_TIME_ZONE = 'America/Mexico_City';
const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_FIELDS = ['status', 'subStatus', 'paidStatus', 'invoicedStatus', 'shippedStatus'] as const;
type StatusField = (typeof STATUS_FIELDS)[number];
type StatusCombo = Record<StatusField, string | null> & { count: number };

/**
 * Distinct status combinations present in the DB. Status values come from
 * Zoho in inconsistent spellings ("open", "Open", "onhold", "on_hold"), and
 * the ticket status is computed (not a column), so filters are resolved
 * against the real values instead of trusting the literal the UI sends.
 */
async function loadStatusCombos(): Promise<StatusCombo[]> {
  const groups = await prisma.salesOrder.groupBy({
    by: [...STATUS_FIELDS],
    _count: { _all: true },
  });
  return groups.map((g) => ({
    status: g.status,
    subStatus: g.subStatus,
    paidStatus: g.paidStatus,
    invoicedStatus: g.invoicedStatus,
    shippedStatus: g.shippedStatus,
    count: g._count._all,
  }));
}

function compactKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

type StatusCategory = NonNullable<(typeof SALES_ORDER_COLUMNS)[number]['statusCategory']>;

function statusMatches(raw: string, selected: string, category: StatusCategory): boolean {
  if (compactKey(raw) === compactKey(selected)) return true;
  return (
    getSalesOrderStatusConfig(raw, category).label ===
    getSalesOrderStatusConfig(selected, category).label
  );
}

function ruleValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter((v) => v.trim() !== '');
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()];
  return [];
}

function comboTicketKey(combo: StatusCombo): string {
  return getTicketStatus(combo).raw;
}

function comboWhere(combo: StatusCombo): W {
  return { AND: STATUS_FIELDS.map((f) => ({ [f]: combo[f] === null ? null : combo[f] }) as W) };
}

function buildTicketWhere(rule: SalesOrderFilterRule, combos: StatusCombo[]): W {
  const op = rule.operator;
  if (op === 'is_empty') return MATCH_NONE; // always computed, never empty
  const selected = ruleValues(rule.value);
  if (selected.length === 0) return {};
  const negate = op === 'not_equals' || op === 'not_in';
  if (!negate && op !== 'equals' && op !== 'in') return {};
  const wanted = new Set(selected);
  const matching = combos.filter((c) => wanted.has(comboTicketKey(c)) !== negate);
  if (matching.length === 0) return MATCH_NONE;
  return { OR: matching.map(comboWhere) };
}

function buildStatusWhere(
  field: StatusField,
  category: StatusCategory,
  rule: SalesOrderFilterRule,
  combos: StatusCombo[]
): W {
  const op = rule.operator;
  if (op === 'is_empty') return { OR: [{ [field]: null }, { [field]: '' }] } as W;
  const selected = ruleValues(rule.value);
  if (selected.length === 0) return {};
  const distinct = [...new Set(combos.map((c) => c[field]).filter((v): v is string => !!v))];
  const matched = distinct.filter((raw) => selected.some((sel) => statusMatches(raw, sel, category)));
  if (op === 'equals' || op === 'in') {
    return matched.length === 0 ? MATCH_NONE : ({ [field]: { in: matched } } as W);
  }
  if (op === 'not_equals' || op === 'not_in') {
    if (matched.length === 0) return {};
    return { OR: [{ [field]: null }, { [field]: { notIn: matched } }] } as W;
  }
  return {};
}

function buildTextWhere(field: string, rule: SalesOrderFilterRule): W {
  const op = rule.operator;
  if (op === 'is_empty') return { OR: [{ [field]: null }, { [field]: '' }] } as W;
  if (op === 'is_not_empty') return { AND: [{ [field]: { not: null } }, { [field]: { not: '' } }] } as W;
  const val = typeof rule.value === 'string' ? rule.value.trim() : typeof rule.value === 'number' ? String(rule.value) : '';
  if (!val) return {};
  const ci = { mode: 'insensitive' as const };
  switch (op) {
    case 'contains':
      return { [field]: { contains: val, ...ci } } as W;
    case 'not_contains':
      return { OR: [{ [field]: null }, { NOT: { [field]: { contains: val, ...ci } } }] } as W;
    case 'equals':
      return { [field]: { equals: val, ...ci } } as W;
    case 'not_equals':
      return { OR: [{ [field]: null }, { NOT: { [field]: { equals: val, ...ci } } }] } as W;
    case 'starts_with':
      return { [field]: { startsWith: val, ...ci } } as W;
    default:
      return {};
  }
}

function toNumber(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function buildNumberWhere(field: string, rule: SalesOrderFilterRule): W {
  const num = toNumber(rule.value);
  const numTo = toNumber(rule.valueTo);
  if (rule.operator === 'between') {
    if (num === null || numTo === null) return {};
    return { [field]: { gte: Math.min(num, numTo), lte: Math.max(num, numTo) } } as W;
  }
  if (num === null) return {};
  const map: Record<string, string> = {
    equals: 'equals',
    greater_than: 'gt',
    greater_or_equal: 'gte',
    less_than: 'lt',
    less_or_equal: 'lte',
  };
  const key = map[rule.operator];
  return key ? ({ [field]: { [key]: num } } as W) : {};
}

/** Parses `YYYY-MM-DD` (or any ISO string) to the UTC midnight of that calendar day. */
function parseDay(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (match) return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? null
    : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

function todayInBusinessZone(): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parseDay(parts) as Date;
}

/** Returns a half-open [from, to) range of calendar days for a shortcut. */
function resolveDateShortcut(shortcut: string): { from: Date; to: Date } | null {
  const today = todayInBusinessZone();
  const tomorrow = new Date(today.getTime() + DAY_MS);
  switch (shortcut) {
    case 'today':
      return { from: today, to: tomorrow };
    case 'yesterday':
      return { from: new Date(today.getTime() - DAY_MS), to: today };
    case 'this_week': {
      const day = today.getUTCDay(); // 0 = domingo
      const offset = day === 0 ? 6 : day - 1; // semana inicia lunes
      return { from: new Date(today.getTime() - offset * DAY_MS), to: tomorrow };
    }
    case 'this_month':
      return {
        from: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)),
        to: tomorrow,
      };
    case 'last_7_days':
      return { from: new Date(today.getTime() - 6 * DAY_MS), to: tomorrow };
    case 'last_30_days':
      return { from: new Date(today.getTime() - 29 * DAY_MS), to: tomorrow };
    default:
      return null;
  }
}

function buildDateWhere(field: string, rule: SalesOrderFilterRule): W {
  if (rule.shortcut && DATE_SHORTCUTS.includes(rule.shortcut)) {
    const range = resolveDateShortcut(rule.shortcut);
    if (range) return { [field]: { gte: range.from, lt: range.to } } as W;
  }
  const from = parseDay(rule.value);
  const to = parseDay(rule.valueTo);
  switch (rule.operator) {
    case 'equals':
      return from ? ({ [field]: { gte: from, lt: new Date(from.getTime() + DAY_MS) } } as W) : {};
    case 'before':
      return from ? ({ [field]: { lt: from } } as W) : {};
    case 'after':
      return from ? ({ [field]: { gte: new Date(from.getTime() + DAY_MS) } } as W) : {};
    case 'between': {
      if (!from || !to) return {};
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      return { [field]: { gte: lo, lt: new Date(hi.getTime() + DAY_MS) } } as W;
    }
    default:
      return {};
  }
}

function buildBooleanWhere(field: string, rule: SalesOrderFilterRule): W {
  if (rule.operator !== 'equals') return {};
  const val = rule.value === true || rule.value === 'true' ? true : rule.value === false || rule.value === 'false' ? false : null;
  return val === null ? {} : ({ [field]: val } as W);
}

function buildRuleWhere(rule: SalesOrderFilterRule, combos: StatusCombo[]): W {
  const column = SALES_ORDER_COLUMNS.find((c) => c.field === rule.field && c.filterable);
  if (!column) return {};
  const allowed = FILTER_OPERATORS_BY_TYPE[column.type] ?? [];
  if (!allowed.includes(rule.operator)) return {};

  switch (column.type) {
    case 'text':
      return buildTextWhere(column.field, rule);
    case 'status':
      if (column.field === 'ticketStatus') return buildTicketWhere(rule, combos);
      if ((STATUS_FIELDS as readonly string[]).includes(column.field) && column.statusCategory)
        return buildStatusWhere(column.field as StatusField, column.statusCategory, rule, combos);
      return {};
    case 'number':
    case 'currency':
      return buildNumberWhere(column.field, rule);
    case 'date':
      return buildDateWhere(column.field, rule);
    case 'boolean':
      return buildBooleanWhere(column.field, rule);
    default:
      return {};
  }
}

function needsStatusCombos(filterGroup: SalesOrderFilterGroup): boolean {
  return filterGroup.rules.some((r) => {
    const col = SALES_ORDER_COLUMNS.find((c) => c.field === r.field);
    return col?.type === 'status';
  });
}

async function buildFilterWhere(filterGroup: SalesOrderFilterGroup): Promise<W> {
  if (!filterGroup.rules || filterGroup.rules.length === 0) return {};
  const combos = needsStatusCombos(filterGroup) ? await loadStatusCombos() : [];
  const conditions = filterGroup.rules
    .map((rule) => buildRuleWhere(rule, combos))
    .filter((c) => Object.keys(c).length > 0);
  if (conditions.length === 0) return {};
  if (filterGroup.logic === 'OR') return { OR: conditions };
  return { AND: conditions };
}

function buildSearchWhere(search: string | undefined): W {
  const term = search?.trim();
  if (!term) return {};
  return {
    OR: [
      { salesOrderNumber: { contains: term, mode: 'insensitive' } },
      { customerName: { contains: term, mode: 'insensitive' } },
      { customerPhone: { contains: term, mode: 'insensitive' } },
      { referenceNumber: { contains: term, mode: 'insensitive' } },
    ],
  };
}

function buildSortOrderBy(sort: SalesOrderSort): Prisma.SalesOrderOrderByWithRelationInput[] {
  if (!sort || sort.length === 0) {
    return [{ salesOrderNumber: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
  }
  return sort.map((s) => ({ [s.field]: s.direction }) as Prisma.SalesOrderOrderByWithRelationInput);
}

async function buildWhere(query: SalesOrderQueryState): Promise<W> {
  const searchWhere = buildSearchWhere(query.search);
  const filterWhere = await buildFilterWhere(query.filters);
  return { AND: [searchWhere, filterWhere].filter((w) => Object.keys(w).length > 0) };
}

// ---------------------------------------------------------------------------
// Filter options — status values that actually exist, with counts
// ---------------------------------------------------------------------------

export type SalesOrderFilterOptions = Record<string, { value: string; label: string; count: number }[]>;

export async function getSalesOrderFilterOptions(): Promise<SalesOrderFilterOptions> {
  const combos = await loadStatusCombos();
  const options: SalesOrderFilterOptions = {};
  for (const column of SALES_ORDER_COLUMNS) {
    if (column.type !== 'status' || !column.filterable || !column.statusCategory) continue;
    const byLabel = new Map<string, { value: string; label: string; count: number }>();
    for (const combo of combos) {
      let raw: string | null;
      if (column.field === 'ticketStatus') raw = comboTicketKey(combo);
      else if ((STATUS_FIELDS as readonly string[]).includes(column.field))
        raw = combo[column.field as StatusField];
      else continue;
      if (!raw) continue;
      const config = getSalesOrderStatusConfig(raw, column.statusCategory);
      const existing = byLabel.get(config.label);
      if (existing) existing.count += combo.count;
      else byLabel.set(config.label, { value: config.raw || raw, label: config.label, count: combo.count });
    }
    options[column.field] = [...byLabel.values()].sort((a, b) => b.count - a.count);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Carrier lookup — batch fetch transportista from related packages
// ---------------------------------------------------------------------------

/**
 * Batch-lookup the carrier (transportista) for a set of sales orders by
 * joining with the Package table. Tries two match strategies:
 *   1. Package.zohoSalesOrderId  = SalesOrder.zohoSalesOrderId  (preferred)
 *   2. Package.salesorderNumber = SalesOrder.salesOrderNumber  (fallback)
 * Returns a map keyed by SalesOrder.id → carrier name.
 * When multiple packages exist for the same order, the most recent
 * (by package date) wins.
 */
async function batchLookupCarriers<T extends {
  id: string;
  zohoSalesOrderId: string | null;
  salesOrderNumber: string | null;
}>(
  orders: T[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (orders.length === 0) return result;

  const zohoIds = orders
    .map((o) => o.zohoSalesOrderId)
    .filter((id): id is string => Boolean(id));

  // Build index: zohoSalesOrderId → SalesOrder.id
  const zohoIdToOrderId = new Map<string, string>();
  for (const o of orders) {
    if (o.zohoSalesOrderId) zohoIdToOrderId.set(o.zohoSalesOrderId, o.id);
  }
  // Build index: salesOrderNumber → SalesOrder.id
  const orderNumberToOrderId = new Map<string, string>();
  for (const o of orders) {
    if (o.salesOrderNumber) orderNumberToOrderId.set(o.salesOrderNumber, o.id);
  }

  // Strategy 1: match by zohoSalesOrderId
  if (zohoIds.length > 0) {
    const packages = await prisma.package.findMany({
      where: { zohoSalesOrderId: { in: zohoIds } },
      select: { zohoSalesOrderId: true, carrier: true, date: true },
      orderBy: { date: 'desc' },
    });
    for (const pkg of packages) {
      const orderId = pkg.zohoSalesOrderId ? zohoIdToOrderId.get(pkg.zohoSalesOrderId) : null;
      if (orderId && pkg.carrier && !result.has(orderId)) {
        result.set(orderId, pkg.carrier);
      }
    }
  }

  // Strategy 2: fallback — match by salesorderNumber for orders not yet resolved
  const unresolvedOrderNumbers = orders
    .filter((o) => !result.has(o.id))
    .map((o) => o.salesOrderNumber)
    .filter((n): n is string => n !== null && n.trim().length > 0);
  if (unresolvedOrderNumbers.length > 0) {
    const packages = await prisma.package.findMany({
      where: { salesorderNumber: { in: unresolvedOrderNumbers } },
      select: { salesorderNumber: true, carrier: true, date: true },
      orderBy: { date: 'desc' },
    });
    for (const pkg of packages) {
      const orderId = pkg.salesorderNumber ? orderNumberToOrderId.get(pkg.salesorderNumber) : null;
      if (orderId && pkg.carrier && !result.has(orderId)) {
        result.set(orderId, pkg.carrier);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public query functions
// ---------------------------------------------------------------------------

export interface SalesOrdersListResult {
  data: SalesOrderListRow[];
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
  aggregates: {
    count: number;
    total_sum: string | null;
    balance_sum: string | null;
  };
}

export async function getSalesOrdersWorkspace(rawQuery: unknown): Promise<SalesOrdersListResult> {
  const query = salesOrderQueryStateSchema.parse(rawQuery);
  const where = await buildWhere(query);
  const orderBy = buildSortOrderBy(query.sort);
  const skip = (query.page - MIN_PAGE) * query.page_size;

  const [orders, total, aggregates] = await Promise.all([
    prisma.salesOrder.findMany({
      where,
      orderBy,
      take: query.page_size,
      skip,
      select: LIST_SELECT,
    }),
    prisma.salesOrder.count({ where }),
    prisma.salesOrder.aggregate({
      where,
      _count: { _all: true },
      _sum: { total: true, balance: true },
    }),
  ]);

  const totalPages = Math.ceil(total / query.page_size);

  const carrierByOrderId = await batchLookupCarriers(orders);
  const rows = orders.map((o) =>
    toSalesOrderListRow({
      ...o,
      carrier: carrierByOrderId.get(o.id) ?? null,
    })
  );

  return {
    data: rows,
    pagination: {
      page: query.page,
      page_size: query.page_size,
      total,
      total_pages: totalPages,
    },
    aggregates: {
      count: aggregates._count._all,
      total_sum: aggregates._sum.total?.toString() ?? null,
      balance_sum: aggregates._sum.balance?.toString() ?? null,
    },
  };
}

export async function getSalesOrderById(id: string): Promise<SalesOrderDetail | null> {
  const order = await prisma.salesOrder.findUnique({
    where: { id },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });

  if (!order) return null;

  return toSalesOrderDetail(order, order.items);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportOptions {
  format: 'csv' | 'xlsx';
  scope: 'current_page' | 'selected' | 'filtered';
  selectedIds?: string[];
  includeAllColumns?: boolean;
  /** Column IDs the user has visible in their table view. Used when includeAllColumns is false. */
  visibleColumns?: string[];
  page?: number;
  pageSize?: number;
}


function getExportColumns(
  includeAll: boolean,
  visibleColumns?: string[]
): typeof SALES_ORDER_COLUMNS {
  if (includeAll) return SALES_ORDER_COLUMNS;
  // If the user's visible columns are provided, export exactly those (in priority order)
  if (visibleColumns && visibleColumns.length > 0) {
    const visibleSet = new Set(visibleColumns);
    return SALES_ORDER_COLUMNS.filter((c) => visibleSet.has(c.id));
  }
  // Fallback: default visible columns
  return SALES_ORDER_COLUMNS.filter((c) => c.defaultVisible);
}

function formatExportValue(row: SalesOrderListRow, columnId: string): string {
  const column = SALES_ORDER_COLUMN_MAP[columnId];
  if (!column) return '';
  const value = (row as unknown as Record<string, unknown>)[columnId];
  if (value === null || value === undefined) return '';
  if (column.formatter === 'currency')
    return formatCurrency(value as string | number, row.currencyCode);
  if (column.formatter === 'date') return formatDateOnly(value as string | Date);
  if (column.formatter === 'boolean') return value === true ? 'Sí' : value === false ? 'No' : '';
  if (column.formatter === 'statusDot') {
    return getSalesOrderStatusConfig(value as string | null, column.statusCategory).label;
  }
  return String(value);
}

type SalesOrderListEntity = {
  id: string;
  zohoSalesOrderId: string | null;
  salesOrderNumber: string | null;
  referenceNumber: string | null;
  orderDate: Date | null;
  customerName: string | null;
  customerPhone: string | null;
  salespersonName: string | null;
  paymentMethod: string | null;
  deliveryMethod: string | null;
  locationName: string | null;
  branchName: string | null;
  status: string | null;
  subStatus: string | null;
  paidStatus: string | null;
  invoicedStatus: string | null;
  shippedStatus: string | null;
  currencyCode: string | null;
  subtotal: Prisma.Decimal | null;
  discountTotal: Prisma.Decimal | null;
  taxTotal: Prisma.Decimal | null;
  shippingCharge: Prisma.Decimal | null;
  adjustment: Prisma.Decimal | null;
  total: Prisma.Decimal | null;
  balance: Prisma.Decimal | null;
  saleMadeInWarehouse: boolean | null;
  sourceRemoteModifiedAt: Date;
  shippingAddressLine1: string | null;
  shippingAddressLine2: string | null;
};

export async function getSalesOrdersForExport(
  rawQuery: unknown,
  options: ExportOptions
): Promise<{ rows: SalesOrderListRow[]; columns: typeof SALES_ORDER_COLUMNS }> {
  const query = salesOrderQueryStateSchema.parse(rawQuery);
  const where = await buildWhere(query);
  const orderBy = buildSortOrderBy(query.sort);

  let orders: SalesOrderListEntity[];

  if (options.scope === 'selected' && options.selectedIds && options.selectedIds.length > 0) {
    const selectedWhere = { ...where, id: { in: options.selectedIds } };
    orders = await prisma.salesOrder.findMany({
      where: selectedWhere,
      orderBy,
      take: Math.min(options.selectedIds.length, MAX_EXPORT_ROWS),
      select: LIST_SELECT,
    });
  } else if (options.scope === 'current_page') {
    const skip = ((options.page ?? query.page) - MIN_PAGE) * (options.pageSize ?? query.page_size);
    orders = await prisma.salesOrder.findMany({
      where,
      orderBy,
      take: options.pageSize ?? query.page_size,
      skip,
      select: LIST_SELECT,
    });
  } else {
    orders = await prisma.salesOrder.findMany({
      where,
      orderBy,
      take: MAX_EXPORT_ROWS,
      select: LIST_SELECT,
    });
  }

  const carrierByOrderId = await batchLookupCarriers(orders);
  const rows = orders.map((o) =>
    toSalesOrderListRow({
      ...o,
      carrier: carrierByOrderId.get(o.id) ?? null,
    })
  );

  const columns = getExportColumns(options.includeAllColumns ?? false, options.visibleColumns);
  return { rows, columns };
}

export function buildCsv(rows: SalesOrderListRow[], columns: typeof SALES_ORDER_COLUMNS): string {
  const header = columns.map((c) => `"${c.label.replace(/"/g, '""')}"`).join(',');
  const lines = rows.map((row) =>
    columns
      .map((c) => {
        const val = formatExportValue(row, c.id);
        return `"${val.replace(/"/g, '""')}"`;
      })
      .join(',')
  );
  return [header, ...lines].join('\r\n');
}

// ---------------------------------------------------------------------------
// Legacy compat (existing API route consumers)
// ---------------------------------------------------------------------------

export const salesOrderListQuerySchema = legacySalesOrderListQuerySchema;

export async function getSalesOrdersList(query: LegacySalesOrderListQuery) {
  const where: Prisma.SalesOrderWhereInput = {};
  if (query.date_from) where.orderDate = { gte: query.date_from };
  if (query.date_to) where.orderDate = { ...(where.orderDate as object), lte: query.date_to };
  if (query.status) where.status = { contains: query.status, mode: 'insensitive' };
  if (query.salesperson)
    where.salespersonName = { contains: query.salesperson, mode: 'insensitive' };
  if (query.payment_method)
    where.paymentMethod = { contains: query.payment_method, mode: 'insensitive' };
  if (query.delivery_method)
    where.deliveryMethod = { contains: query.delivery_method, mode: 'insensitive' };
  if (query.location) where.locationName = { contains: query.location, mode: 'insensitive' };
  if (query.search && query.search.length > 0) {
    where.OR = [
      { salesOrderNumber: { contains: query.search, mode: 'insensitive' } },
      { customerName: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const skip = (query.page - MIN_PAGE) * query.page_size;
  const [orders, total] = await Promise.all([
    prisma.salesOrder.findMany({
      where,
      orderBy: { orderDate: 'desc' },
      take: query.page_size,
      skip,
      select: {
        id: true,
        salesOrderNumber: true,
        orderDate: true,
        customerName: true,
        customerPhone: true,
        salespersonName: true,
        paymentMethod: true,
        deliveryMethod: true,
        locationName: true,
        status: true,
        paidStatus: true,
        invoicedStatus: true,
        shippedStatus: true,
        total: true,
        currencyCode: true,
      },
    }),
    prisma.salesOrder.count({ where }),
  ]);

  const totalPages = Math.ceil(total / query.page_size);
  return {
    data: orders.map((o) => ({
      id: o.id,
      sales_order_number: o.salesOrderNumber,
      order_date: o.orderDate?.toISOString().split('T')[0] ?? null,
      customer_name: o.customerName,
      customer_phone: o.customerPhone,
      salesperson_name: o.salespersonName,
      payment_method: o.paymentMethod,
      delivery_method: o.deliveryMethod,
      location_name: o.locationName,
      status: o.status,
      paid_status: o.paidStatus,
      invoiced_status: o.invoicedStatus,
      shipped_status: o.shippedStatus,
      total: o.total?.toString() ?? null,
      currency_code: o.currencyCode,
    })),
    pagination: {
      page: query.page,
      page_size: query.page_size,
      total,
      total_pages: totalPages,
    },
  };
}
