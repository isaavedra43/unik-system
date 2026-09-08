import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { SALES_ORDER_COLUMNS, SALES_ORDER_COLUMN_MAP } from './sales-orders-columns';
import {
  salesOrderFilterGroupSchema,
  salesOrderQueryStateSchema,
  SalesOrderFilterGroup,
  SalesOrderQueryState,
  SalesOrderSort,
  DATE_SHORTCUTS,
} from './sales-orders-filters';
import { toSalesOrderListRow, toSalesOrderDetail } from './sales-orders-contract';
import type { SalesOrderListRow, SalesOrderDetail } from './sales-orders-contract';
import { formatCurrency, formatDateOnly, getSalesOrderStatusConfig } from './sales-orders-helpers';

const MIN_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_EXPORT_ROWS = 50_000;

/**
 * @deprecated Use salesOrderQueryStateSchema instead. Kept for backward compat
 * with any existing API route consumers.
 */
export const legacySalesOrderListQuerySchema = z.object({
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

export type LegacySalesOrderListQuery = z.output<typeof legacySalesOrderListQuerySchema>;

export type { SalesOrderListRow, SalesOrderDetail };

/** @deprecated Use SalesOrderListRow. Kept until all consumers migrate. */
export type SalesOrderListItem = SalesOrderListRow;

const LIST_SELECT = {
  id: true,
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

function resolveDateShortcut(shortcut: string): { from: Date; to: Date } | null {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);
  endOfDay.setMilliseconds(-1);

  switch (shortcut) {
    case 'today':
      return { from: startOfDay, to: endOfDay };
    case 'yesterday': {
      const from = new Date(startOfDay);
      from.setDate(from.getDate() - 1);
      const to = new Date(endOfDay);
      to.setDate(to.getDate() - 1);
      return { from, to };
    }
    case 'this_week': {
      const day = startOfDay.getDay();
      const from = new Date(startOfDay);
      from.setDate(from.getDate() - day);
      return { from, to: endOfDay };
    }
    case 'this_month': {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from, to: endOfDay };
    }
    case 'last_7_days': {
      const from = new Date(startOfDay);
      from.setDate(from.getDate() - 6);
      return { from, to: endOfDay };
    }
    case 'last_30_days': {
      const from = new Date(startOfDay);
      from.setDate(from.getDate() - 29);
      return { from, to: endOfDay };
    }
    default:
      return null;
  }
}

function parseDate(value: string | Date): Date | null {
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildRuleWhere(
  rule: z.infer<typeof salesOrderFilterGroupSchema>['rules'][number]
): Prisma.SalesOrderWhereInput {
  const column = SALES_ORDER_COLUMNS.find((c) => c.field === rule.field);
  if (!column) return {};

  const field = rule.field as keyof Prisma.SalesOrderWhereInput;
  const type = column.type;

  switch (type) {
    case 'text': {
      const op = rule.operator as string;
      const val = 'value' in rule ? (rule.value as string | undefined) : undefined;
      if (op === 'is_empty') return { [field]: { equals: null } } as Prisma.SalesOrderWhereInput;
      if (op === 'is_not_empty') return { [field]: { not: null } } as Prisma.SalesOrderWhereInput;
      if (!val) return {};
      if (op === 'contains')
        return { [field]: { contains: val, mode: 'insensitive' } } as Prisma.SalesOrderWhereInput;
      if (op === 'not_contains')
        return {
          [field]: { not: { contains: val, mode: 'insensitive' } },
        } as Prisma.SalesOrderWhereInput;
      if (op === 'equals')
        return { [field]: { equals: val, mode: 'insensitive' } } as Prisma.SalesOrderWhereInput;
      if (op === 'not_equals')
        return {
          [field]: { not: { equals: val, mode: 'insensitive' } },
        } as Prisma.SalesOrderWhereInput;
      if (op === 'starts_with')
        return { [field]: { startsWith: val, mode: 'insensitive' } } as Prisma.SalesOrderWhereInput;
      return {};
    }
    case 'status': {
      const op = rule.operator as string;
      const val = 'value' in rule ? rule.value : undefined;
      if (op === 'is_empty') return { [field]: { equals: null } } as Prisma.SalesOrderWhereInput;
      if (op === 'equals') {
        if (typeof val !== 'string') return {};
        return { [field]: { equals: val, mode: 'insensitive' } } as Prisma.SalesOrderWhereInput;
      }
      if (op === 'not_equals') {
        if (typeof val !== 'string') return {};
        return {
          [field]: { not: { equals: val, mode: 'insensitive' } },
        } as Prisma.SalesOrderWhereInput;
      }
      if (op === 'in') {
        const arr = Array.isArray(val) ? val : typeof val === 'string' ? [val] : [];
        if (arr.length === 0) return {};
        return { [field]: { in: arr, mode: 'insensitive' } } as Prisma.SalesOrderWhereInput;
      }
      if (op === 'not_in') {
        const arr = Array.isArray(val) ? val : typeof val === 'string' ? [val] : [];
        if (arr.length === 0) return {};
        return {
          [field]: { notIn: arr, mode: 'insensitive' },
        } as Prisma.SalesOrderWhereInput;
      }
      return {};
    }
    case 'number':
    case 'currency': {
      const op = rule.operator as string;
      const raw = 'value' in rule ? rule.value : undefined;
      const rawTo = 'valueTo' in rule ? rule.valueTo : undefined;
      const num = raw !== undefined && raw !== null && raw !== '' ? Number(raw) : null;
      const numTo = rawTo !== undefined && rawTo !== null && rawTo !== '' ? Number(rawTo) : null;
      if (op === 'equals' && num !== null && !Number.isNaN(num))
        return { [field]: { equals: num } } as Prisma.SalesOrderWhereInput;
      if (op === 'greater_than' && num !== null && !Number.isNaN(num))
        return { [field]: { gt: num } } as Prisma.SalesOrderWhereInput;
      if (op === 'greater_or_equal' && num !== null && !Number.isNaN(num))
        return { [field]: { gte: num } } as Prisma.SalesOrderWhereInput;
      if (op === 'less_than' && num !== null && !Number.isNaN(num))
        return { [field]: { lt: num } } as Prisma.SalesOrderWhereInput;
      if (op === 'less_or_equal' && num !== null && !Number.isNaN(num))
        return { [field]: { lte: num } } as Prisma.SalesOrderWhereInput;
      if (
        op === 'between' &&
        num !== null &&
        numTo !== null &&
        !Number.isNaN(num) &&
        !Number.isNaN(numTo)
      )
        return { [field]: { gte: num, lte: numTo } } as Prisma.SalesOrderWhereInput;
      return {};
    }
    case 'date': {
      const op = rule.operator as string;
      const shortcut = 'shortcut' in rule ? rule.shortcut : undefined;
      const rawVal = 'value' in rule ? rule.value : undefined;
      const rawValTo = 'valueTo' in rule ? rule.valueTo : undefined;

      if (shortcut && DATE_SHORTCUTS.includes(shortcut as (typeof DATE_SHORTCUTS)[number])) {
        const range = resolveDateShortcut(shortcut);
        if (range)
          return { [field]: { gte: range.from, lte: range.to } } as Prisma.SalesOrderWhereInput;
      }

      const val = rawVal ? parseDate(rawVal as string | Date) : null;
      const valTo = rawValTo ? parseDate(rawValTo as string | Date) : null;
      if (op === 'equals' && val)
        return { [field]: { equals: val } } as Prisma.SalesOrderWhereInput;
      if (op === 'before' && val) return { [field]: { lt: val } } as Prisma.SalesOrderWhereInput;
      if (op === 'after' && val) return { [field]: { gt: val } } as Prisma.SalesOrderWhereInput;
      if (op === 'between' && val && valTo)
        return { [field]: { gte: val, lte: valTo } } as Prisma.SalesOrderWhereInput;
      return {};
    }
    case 'boolean': {
      const op = rule.operator as string;
      const val = 'value' in rule ? rule.value : undefined;
      if (op === 'equals' && typeof val === 'boolean')
        return { [field]: { equals: val } } as Prisma.SalesOrderWhereInput;
      return {};
    }
    default:
      return {};
  }
}

function buildFilterWhere(filterGroup: SalesOrderFilterGroup): Prisma.SalesOrderWhereInput {
  if (!filterGroup.rules || filterGroup.rules.length === 0) return {};
  const conditions = filterGroup.rules.map(buildRuleWhere).filter((c) => Object.keys(c).length > 0);
  if (conditions.length === 0) return {};
  if (filterGroup.logic === 'OR') return { OR: conditions };
  return { AND: conditions };
}

function buildSearchWhere(search: string | undefined): Prisma.SalesOrderWhereInput {
  if (!search || search.length === 0) return {};
  return {
    OR: [
      { salesOrderNumber: { contains: search, mode: 'insensitive' } },
      { customerName: { contains: search, mode: 'insensitive' } },
      { customerPhone: { contains: search, mode: 'insensitive' } },
      { referenceNumber: { contains: search, mode: 'insensitive' } },
    ],
  };
}

function buildSortOrderBy(sort: SalesOrderSort): Prisma.SalesOrderOrderByWithRelationInput[] {
  if (!sort || sort.length === 0) {
    return [{ salesOrderNumber: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
  }
  return sort.map((s) => ({ [s.field]: s.direction }) as Prisma.SalesOrderOrderByWithRelationInput);
}

function buildWhere(query: SalesOrderQueryState): Prisma.SalesOrderWhereInput {
  const searchWhere = buildSearchWhere(query.search);
  const filterWhere = buildFilterWhere(query.filters);
  return { AND: [searchWhere, filterWhere].filter((w) => Object.keys(w).length > 0) };
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
  const where = buildWhere(query);
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

  return {
    data: orders.map(toSalesOrderListRow),
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
  page?: number;
  pageSize?: number;
}

export interface ExportResult {
  format: 'csv' | 'xlsx';
  rowCount: number;
  /** Base64-encoded content for download. */
  content: string;
  filename: string;
}

export const EXPORT_COLUMN_IDS = SALES_ORDER_COLUMNS.map((c) => c.id);

function getExportColumns(includeAll: boolean): typeof SALES_ORDER_COLUMNS {
  if (includeAll) return SALES_ORDER_COLUMNS;
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

export async function getSalesOrdersForExport(
  rawQuery: unknown,
  options: ExportOptions
): Promise<{ rows: SalesOrderListRow[]; columns: typeof SALES_ORDER_COLUMNS }> {
  const query = salesOrderQueryStateSchema.parse(rawQuery);
  const where = buildWhere(query);
  const orderBy = buildSortOrderBy(query.sort);

  let rows: SalesOrderListRow[];

  if (options.scope === 'selected' && options.selectedIds && options.selectedIds.length > 0) {
    const selectedWhere = { ...where, id: { in: options.selectedIds } };
    const orders = await prisma.salesOrder.findMany({
      where: selectedWhere,
      orderBy,
      take: Math.min(options.selectedIds.length, MAX_EXPORT_ROWS),
      select: LIST_SELECT,
    });
    rows = orders.map(toSalesOrderListRow);
  } else if (options.scope === 'current_page') {
    const skip = ((options.page ?? query.page) - MIN_PAGE) * (options.pageSize ?? query.page_size);
    const orders = await prisma.salesOrder.findMany({
      where,
      orderBy,
      take: options.pageSize ?? query.page_size,
      skip,
      select: LIST_SELECT,
    });
    rows = orders.map(toSalesOrderListRow);
  } else {
    const orders = await prisma.salesOrder.findMany({
      where,
      orderBy,
      take: MAX_EXPORT_ROWS,
      select: LIST_SELECT,
    });
    rows = orders.map(toSalesOrderListRow);
  }

  const columns = getExportColumns(options.includeAllColumns ?? false);
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

export function buildCsvFromRows(
  rows: SalesOrderListRow[],
  columns: typeof SALES_ORDER_COLUMNS
): string {
  return buildCsv(rows, columns);
}

// ---------------------------------------------------------------------------
// Legacy compat (existing API route consumers)
// ---------------------------------------------------------------------------

export const salesOrderListQuerySchema = legacySalesOrderListQuerySchema;
export type SalesOrderListQuery = LegacySalesOrderListQuery;

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
