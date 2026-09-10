import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import {
  PURCHASE_ORDER_COLUMNS,
  PURCHASE_ORDER_COLUMN_MAP,
} from './purchase-orders-columns';
import {
  purchaseOrderFilterGroupSchema,
  purchaseOrderQueryStateSchema,
  type PurchaseOrderFilterGroup,
  type PurchaseOrderQueryState,
  type PurchaseOrderSort,
  DATE_SHORTCUTS,
} from './purchase-orders-filters';
import { toPurchaseOrderListRow, toPurchaseOrderDetail } from './purchase-orders-contract';
import type { PurchaseOrderListRow, PurchaseOrderDetail } from './purchase-orders-contract';
import {
  formatCurrency,
  formatDateOnly,
  getPurchaseOrderStatusConfig,
  formatNumber,
} from './purchase-orders-helpers';
import type { EntityListResult } from '@/modules/shared/entity-workspace-types';

const MIN_PAGE = 1;
const MAX_EXPORT_ROWS = 50_000;

export type { PurchaseOrderListRow, PurchaseOrderDetail };

const LIST_SELECT = {
  id: true,
  purchaseOrderNumber: true,
  status: true,
  date: true,
  dueDate: true,
  vendorName: true,
  total: true,
  balance: true,
  currencyCode: true,
  sourceRemoteModifiedAt: true,
} satisfies Prisma.PurchaseOrderSelect;

function isPrismaTableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('does not exist') ||
      msg.includes('relation') ||
      msg.includes('p2021') ||
      msg.includes('the table') ||
      msg.includes('no such table')
    );
  }
  return false;
}

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
  rule: z.infer<typeof purchaseOrderFilterGroupSchema>['rules'][number]
): Prisma.PurchaseOrderWhereInput {
  const column = PURCHASE_ORDER_COLUMNS.find((c) => c.field === rule.field);
  if (!column) return {};

  const field = rule.field as keyof Prisma.PurchaseOrderWhereInput;
  const type = column.type;

  switch (type) {
    case 'text': {
      const op = rule.operator as string;
      const val = 'value' in rule ? (rule.value as string | undefined) : undefined;
      if (op === 'is_empty')
        return { [field]: { equals: null } } as Prisma.PurchaseOrderWhereInput;
      if (op === 'is_not_empty')
        return { [field]: { not: null } } as Prisma.PurchaseOrderWhereInput;
      if (!val) return {};
      if (op === 'contains')
        return { [field]: { contains: val, mode: 'insensitive' } } as Prisma.PurchaseOrderWhereInput;
      if (op === 'not_contains')
        return {
          [field]: { not: { contains: val, mode: 'insensitive' } },
        } as Prisma.PurchaseOrderWhereInput;
      if (op === 'equals')
        return { [field]: { equals: val, mode: 'insensitive' } } as Prisma.PurchaseOrderWhereInput;
      if (op === 'not_equals')
        return {
          [field]: { not: { equals: val, mode: 'insensitive' } },
        } as Prisma.PurchaseOrderWhereInput;
      if (op === 'starts_with')
        return {
          [field]: { startsWith: val, mode: 'insensitive' },
        } as Prisma.PurchaseOrderWhereInput;
      return {};
    }
    case 'status': {
      const op = rule.operator as string;
      const val = 'value' in rule ? rule.value : undefined;
      if (op === 'is_empty')
        return { [field]: { equals: null } } as Prisma.PurchaseOrderWhereInput;
      if (op === 'equals') {
        if (typeof val !== 'string') return {};
        return { [field]: { equals: val, mode: 'insensitive' } } as Prisma.PurchaseOrderWhereInput;
      }
      if (op === 'not_equals') {
        if (typeof val !== 'string') return {};
        return {
          [field]: { not: { equals: val, mode: 'insensitive' } },
        } as Prisma.PurchaseOrderWhereInput;
      }
      if (op === 'in') {
        const arr = Array.isArray(val) ? val : typeof val === 'string' ? [val] : [];
        if (arr.length === 0) return {};
        return { [field]: { in: arr, mode: 'insensitive' } } as Prisma.PurchaseOrderWhereInput;
      }
      if (op === 'not_in') {
        const arr = Array.isArray(val) ? val : typeof val === 'string' ? [val] : [];
        if (arr.length === 0) return {};
        return {
          [field]: { notIn: arr, mode: 'insensitive' },
        } as Prisma.PurchaseOrderWhereInput;
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
        return { [field]: { equals: num } } as Prisma.PurchaseOrderWhereInput;
      if (op === 'greater_than' && num !== null && !Number.isNaN(num))
        return { [field]: { gt: num } } as Prisma.PurchaseOrderWhereInput;
      if (op === 'greater_or_equal' && num !== null && !Number.isNaN(num))
        return { [field]: { gte: num } } as Prisma.PurchaseOrderWhereInput;
      if (op === 'less_than' && num !== null && !Number.isNaN(num))
        return { [field]: { lt: num } } as Prisma.PurchaseOrderWhereInput;
      if (op === 'less_or_equal' && num !== null && !Number.isNaN(num))
        return { [field]: { lte: num } } as Prisma.PurchaseOrderWhereInput;
      if (
        op === 'between' &&
        num !== null &&
        numTo !== null &&
        !Number.isNaN(num) &&
        !Number.isNaN(numTo)
      )
        return { [field]: { gte: num, lte: numTo } } as Prisma.PurchaseOrderWhereInput;
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
          return { [field]: { gte: range.from, lte: range.to } } as Prisma.PurchaseOrderWhereInput;
      }

      const val = rawVal ? parseDate(rawVal as string | Date) : null;
      const valTo = rawValTo ? parseDate(rawValTo as string | Date) : null;
      if (op === 'equals' && val)
        return { [field]: { equals: val } } as Prisma.PurchaseOrderWhereInput;
      if (op === 'before' && val) return { [field]: { lt: val } } as Prisma.PurchaseOrderWhereInput;
      if (op === 'after' && val) return { [field]: { gt: val } } as Prisma.PurchaseOrderWhereInput;
      if (op === 'between' && val && valTo)
        return { [field]: { gte: val, lte: valTo } } as Prisma.PurchaseOrderWhereInput;
      return {};
    }
    case 'boolean': {
      const op = rule.operator as string;
      const val = 'value' in rule ? rule.value : undefined;
      if (op === 'equals' && typeof val === 'boolean')
        return { [field]: { equals: val } } as Prisma.PurchaseOrderWhereInput;
      return {};
    }
    default:
      return {};
  }
}

function buildFilterWhere(
  filterGroup: PurchaseOrderFilterGroup
): Prisma.PurchaseOrderWhereInput {
  if (!filterGroup.rules || filterGroup.rules.length === 0) return {};
  const conditions = filterGroup.rules
    .map(buildRuleWhere)
    .filter((c) => Object.keys(c).length > 0);
  if (conditions.length === 0) return {};
  if (filterGroup.logic === 'OR') return { OR: conditions };
  return { AND: conditions };
}

function buildSearchWhere(search: string | undefined): Prisma.PurchaseOrderWhereInput {
  if (!search || search.length === 0) return {};
  return {
    OR: [
      { purchaseOrderNumber: { contains: search, mode: 'insensitive' } },
      { vendorName: { contains: search, mode: 'insensitive' } },
      { referenceNumber: { contains: search, mode: 'insensitive' } },
    ],
  };
}

function buildSortOrderBy(
  sort: PurchaseOrderSort
): Prisma.PurchaseOrderOrderByWithRelationInput[] {
  if (!sort || sort.length === 0) {
    return [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
  }
  return sort.map(
    (s) => ({ [s.field]: s.direction }) as Prisma.PurchaseOrderOrderByWithRelationInput
  );
}

function buildWhere(query: PurchaseOrderQueryState): Prisma.PurchaseOrderWhereInput {
  const searchWhere = buildSearchWhere(query.search);
  const filterWhere = buildFilterWhere(query.filters);
  return {
    AND: [searchWhere, filterWhere].filter((w) => Object.keys(w).length > 0),
  };
}

// ---------------------------------------------------------------------------
// Public query functions
// ---------------------------------------------------------------------------

export async function getPurchaseOrdersWorkspace(
  rawQuery: unknown
): Promise<EntityListResult<PurchaseOrderListRow>> {
  const query = purchaseOrderQueryStateSchema.parse(rawQuery);
  const where = buildWhere(query);
  const orderBy = buildSortOrderBy(query.sort);
  const skip = (query.page - MIN_PAGE) * query.page_size;

  try {
    const [purchaseOrders, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        orderBy,
        take: query.page_size,
        skip,
        select: LIST_SELECT,
      }),
      prisma.purchaseOrder.count({ where }),
    ]);

    const totalPages = Math.ceil(total / query.page_size);

    return {
      data: purchaseOrders.map(toPurchaseOrderListRow),
      pagination: {
        page: query.page,
        page_size: query.page_size,
        total,
        total_pages: totalPages,
      },
    };
  } catch (error) {
    if (isPrismaTableError(error)) {
      console.error(
        'PurchaseOrder table not available — migration may not be applied:',
        error
      );
      return {
        data: [],
        pagination: {
          page: query.page,
          page_size: query.page_size,
          total: 0,
          total_pages: 0,
        },
      };
    }
    throw error;
  }
}

export async function getPurchaseOrderById(
  id: string
): Promise<PurchaseOrderDetail | null> {
  try {
    const purchaseOrder = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!purchaseOrder) return null;
    return toPurchaseOrderDetail(purchaseOrder);
  } catch (error) {
    if (isPrismaTableError(error)) {
      console.error(
        'PurchaseOrder table not available — migration may not be applied:',
        error
      );
      return null;
    }
    throw error;
  }
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


function getExportColumns(
  includeAll: boolean
): typeof PURCHASE_ORDER_COLUMNS {
  if (includeAll) return PURCHASE_ORDER_COLUMNS;
  return PURCHASE_ORDER_COLUMNS.filter((c) => c.defaultVisible);
}

function formatExportValue(row: PurchaseOrderListRow, columnId: string): string {
  const column = PURCHASE_ORDER_COLUMN_MAP[columnId];
  if (!column) return '';
  const value = (row as unknown as Record<string, unknown>)[columnId];
  if (value === null || value === undefined) return '';
  if (column.formatter === 'currency')
    return formatCurrency(value as string | number, row.currencyCode);
  if (column.formatter === 'date') return formatDateOnly(value as string | Date);
  if (column.formatter === 'statusDot') {
    return getPurchaseOrderStatusConfig(value as string | null).label;
  }
  return String(value);
}

export async function getPurchaseOrdersForExport(
  rawQuery: unknown,
  options: ExportOptions
): Promise<{ rows: PurchaseOrderListRow[]; columns: typeof PURCHASE_ORDER_COLUMNS }> {
  const query = purchaseOrderQueryStateSchema.parse(rawQuery);
  const where = buildWhere(query);
  const orderBy = buildSortOrderBy(query.sort);

  let rows: PurchaseOrderListRow[];

  try {
    if (
      options.scope === 'selected' &&
      options.selectedIds &&
      options.selectedIds.length > 0
    ) {
      const selectedWhere = { ...where, id: { in: options.selectedIds } };
      const purchaseOrders = await prisma.purchaseOrder.findMany({
        where: selectedWhere,
        orderBy,
        take: Math.min(options.selectedIds.length, MAX_EXPORT_ROWS),
        select: LIST_SELECT,
      });
      rows = purchaseOrders.map(toPurchaseOrderListRow);
    } else if (options.scope === 'current_page') {
      const skip =
        ((options.page ?? query.page) - MIN_PAGE) * (options.pageSize ?? query.page_size);
      const purchaseOrders = await prisma.purchaseOrder.findMany({
        where,
        orderBy,
        take: options.pageSize ?? query.page_size,
        skip,
        select: LIST_SELECT,
      });
      rows = purchaseOrders.map(toPurchaseOrderListRow);
    } else {
      const purchaseOrders = await prisma.purchaseOrder.findMany({
        where,
        orderBy,
        take: MAX_EXPORT_ROWS,
        select: LIST_SELECT,
      });
      rows = purchaseOrders.map(toPurchaseOrderListRow);
    }
  } catch (error) {
    if (isPrismaTableError(error)) {
      console.error(
        'PurchaseOrder table not available — migration may not be applied:',
        error
      );
      rows = [];
    } else {
      throw error;
    }
  }

  const columns = getExportColumns(options.includeAllColumns ?? false);
  return { rows, columns };
}

export function buildCsv(
  rows: PurchaseOrderListRow[],
  columns: typeof PURCHASE_ORDER_COLUMNS
): string {
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

// Re-export helper utilities for convenience.
export { formatCurrency, formatDateOnly, formatNumber, getPurchaseOrderStatusConfig };
