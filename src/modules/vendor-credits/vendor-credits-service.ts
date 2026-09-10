import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { VENDOR_CREDIT_COLUMNS, VENDOR_CREDIT_COLUMN_MAP } from './vendor-credits-columns';
import {
  vendorCreditFilterGroupSchema,
  vendorCreditQueryStateSchema,
  type VendorCreditFilterGroup,
  type VendorCreditQueryState,
  type VendorCreditSort,
  DATE_SHORTCUTS,
} from './vendor-credits-filters';
import { toVendorCreditListRow, toVendorCreditDetail } from './vendor-credits-contract';
import type { VendorCreditListRow, VendorCreditDetail } from './vendor-credits-contract';
import type { EntityListResult } from '@/modules/shared/entity-workspace-types';
import {
  formatCurrency,
  formatDateOnly,
  getVendorCreditStatusConfig,
} from './vendor-credits-helpers';

const MIN_PAGE = 1;
const MAX_EXPORT_ROWS = 50_000;

export type { VendorCreditListRow, VendorCreditDetail };

const LIST_SELECT = {
  id: true,
  vendorCreditNumber: true,
  status: true,
  date: true,
  vendorName: true,
  total: true,
  balance: true,
  currencyCode: true,
  sourceRemoteModifiedAt: true,
} satisfies Prisma.VendorCreditSelect;

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
  rule: z.infer<typeof vendorCreditFilterGroupSchema>['rules'][number]
): Prisma.VendorCreditWhereInput {
  const column = VENDOR_CREDIT_COLUMNS.find((c) => c.field === rule.field);
  if (!column) return {};

  const field = rule.field as keyof Prisma.VendorCreditWhereInput;
  const type = column.type;

  switch (type) {
    case 'text': {
      const op = rule.operator as string;
      const val = 'value' in rule ? (rule.value as string | undefined) : undefined;
      if (op === 'is_empty')
        return { [field]: { equals: null } } as Prisma.VendorCreditWhereInput;
      if (op === 'is_not_empty')
        return { [field]: { not: null } } as Prisma.VendorCreditWhereInput;
      if (!val) return {};
      if (op === 'contains')
        return { [field]: { contains: val, mode: 'insensitive' } } as Prisma.VendorCreditWhereInput;
      if (op === 'not_contains')
        return {
          [field]: { not: { contains: val, mode: 'insensitive' } },
        } as Prisma.VendorCreditWhereInput;
      if (op === 'equals')
        return { [field]: { equals: val, mode: 'insensitive' } } as Prisma.VendorCreditWhereInput;
      if (op === 'not_equals')
        return {
          [field]: { not: { equals: val, mode: 'insensitive' } },
        } as Prisma.VendorCreditWhereInput;
      if (op === 'starts_with')
        return { [field]: { startsWith: val, mode: 'insensitive' } } as Prisma.VendorCreditWhereInput;
      return {};
    }
    case 'status': {
      const op = rule.operator as string;
      const val = 'value' in rule ? rule.value : undefined;
      if (op === 'is_empty')
        return { [field]: { equals: null } } as Prisma.VendorCreditWhereInput;
      if (op === 'equals') {
        if (typeof val !== 'string') return {};
        return { [field]: { equals: val, mode: 'insensitive' } } as Prisma.VendorCreditWhereInput;
      }
      if (op === 'not_equals') {
        if (typeof val !== 'string') return {};
        return {
          [field]: { not: { equals: val, mode: 'insensitive' } },
        } as Prisma.VendorCreditWhereInput;
      }
      if (op === 'in') {
        const arr = Array.isArray(val) ? val : typeof val === 'string' ? [val] : [];
        if (arr.length === 0) return {};
        return { [field]: { in: arr, mode: 'insensitive' } } as Prisma.VendorCreditWhereInput;
      }
      if (op === 'not_in') {
        const arr = Array.isArray(val) ? val : typeof val === 'string' ? [val] : [];
        if (arr.length === 0) return {};
        return {
          [field]: { notIn: arr, mode: 'insensitive' },
        } as Prisma.VendorCreditWhereInput;
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
        return { [field]: { equals: num } } as Prisma.VendorCreditWhereInput;
      if (op === 'greater_than' && num !== null && !Number.isNaN(num))
        return { [field]: { gt: num } } as Prisma.VendorCreditWhereInput;
      if (op === 'greater_or_equal' && num !== null && !Number.isNaN(num))
        return { [field]: { gte: num } } as Prisma.VendorCreditWhereInput;
      if (op === 'less_than' && num !== null && !Number.isNaN(num))
        return { [field]: { lt: num } } as Prisma.VendorCreditWhereInput;
      if (op === 'less_or_equal' && num !== null && !Number.isNaN(num))
        return { [field]: { lte: num } } as Prisma.VendorCreditWhereInput;
      if (
        op === 'between' &&
        num !== null &&
        numTo !== null &&
        !Number.isNaN(num) &&
        !Number.isNaN(numTo)
      )
        return { [field]: { gte: num, lte: numTo } } as Prisma.VendorCreditWhereInput;
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
          return { [field]: { gte: range.from, lte: range.to } } as Prisma.VendorCreditWhereInput;
      }

      const val = rawVal ? parseDate(rawVal as string | Date) : null;
      const valTo = rawValTo ? parseDate(rawValTo as string | Date) : null;
      if (op === 'equals' && val)
        return { [field]: { equals: val } } as Prisma.VendorCreditWhereInput;
      if (op === 'before' && val) return { [field]: { lt: val } } as Prisma.VendorCreditWhereInput;
      if (op === 'after' && val) return { [field]: { gt: val } } as Prisma.VendorCreditWhereInput;
      if (op === 'between' && val && valTo)
        return { [field]: { gte: val, lte: valTo } } as Prisma.VendorCreditWhereInput;
      return {};
    }
    case 'boolean': {
      const op = rule.operator as string;
      const val = 'value' in rule ? rule.value : undefined;
      if (op === 'equals' && typeof val === 'boolean')
        return { [field]: { equals: val } } as Prisma.VendorCreditWhereInput;
      return {};
    }
    default:
      return {};
  }
}

function buildFilterWhere(filterGroup: VendorCreditFilterGroup): Prisma.VendorCreditWhereInput {
  if (!filterGroup.rules || filterGroup.rules.length === 0) return {};
  const conditions = filterGroup.rules
    .map(buildRuleWhere)
    .filter((c) => Object.keys(c).length > 0);
  if (conditions.length === 0) return {};
  if (filterGroup.logic === 'OR') return { OR: conditions };
  return { AND: conditions };
}

function buildSearchWhere(search: string | undefined): Prisma.VendorCreditWhereInput {
  if (!search || search.length === 0) return {};
  return {
    OR: [
      { vendorCreditNumber: { contains: search, mode: 'insensitive' } },
      { vendorName: { contains: search, mode: 'insensitive' } },
    ],
  };
}

function buildSortOrderBy(sort: VendorCreditSort): Prisma.VendorCreditOrderByWithRelationInput[] {
  if (!sort || sort.length === 0) {
    return [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
  }
  return sort.map(
    (s) => ({ [s.field]: s.direction }) as Prisma.VendorCreditOrderByWithRelationInput
  );
}

function buildWhere(query: VendorCreditQueryState): Prisma.VendorCreditWhereInput {
  const searchWhere = buildSearchWhere(query.search);
  const filterWhere = buildFilterWhere(query.filters);
  return {
    AND: [searchWhere, filterWhere].filter((w) => Object.keys(w).length > 0),
  };
}

// ---------------------------------------------------------------------------
// Public query functions
// ---------------------------------------------------------------------------

type VendorCreditsListResult = EntityListResult<VendorCreditListRow>;

export async function getVendorCreditsWorkspace(
  rawQuery: unknown
): Promise<VendorCreditsListResult> {
  const query = vendorCreditQueryStateSchema.parse(rawQuery);
  const where = buildWhere(query);
  const orderBy = buildSortOrderBy(query.sort);
  const skip = (query.page - MIN_PAGE) * query.page_size;

  try {
    const [vendorCredits, total] = await Promise.all([
      prisma.vendorCredit.findMany({
        where,
        orderBy,
        take: query.page_size,
        skip,
        select: LIST_SELECT,
      }),
      prisma.vendorCredit.count({ where }),
    ]);

    const totalPages = Math.ceil(total / query.page_size);

    return {
      data: vendorCredits.map(toVendorCreditListRow),
      pagination: {
        page: query.page,
        page_size: query.page_size,
        total,
        total_pages: totalPages,
      },
    };
  } catch (error) {
    if (isPrismaTableError(error)) {
      console.error('VendorCredit table not available — migration may not be applied:', error);
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

export async function getVendorCreditById(id: string): Promise<VendorCreditDetail | null> {
  try {
    const vendorCredit = await prisma.vendorCredit.findUnique({ where: { id } });
    if (!vendorCredit) return null;
    return toVendorCreditDetail(vendorCredit);
  } catch (error) {
    if (isPrismaTableError(error)) {
      console.error('VendorCredit table not available — migration may not be applied:', error);
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


function getExportColumns(includeAll: boolean): typeof VENDOR_CREDIT_COLUMNS {
  if (includeAll) return VENDOR_CREDIT_COLUMNS;
  return VENDOR_CREDIT_COLUMNS.filter((c) => c.defaultVisible);
}

function formatExportValue(row: VendorCreditListRow, columnId: string): string {
  const column = VENDOR_CREDIT_COLUMN_MAP[columnId];
  if (!column) return '';
  const value = (row as unknown as Record<string, unknown>)[columnId];
  if (value === null || value === undefined) return '';
  if (column.formatter === 'currency')
    return formatCurrency(value as string | number, row.currencyCode);
  if (column.formatter === 'date') return formatDateOnly(value as string | Date);
  if (column.formatter === 'statusDot') {
    return getVendorCreditStatusConfig(value as string | null).label;
  }
  return String(value);
}

export async function getVendorCreditsForExport(
  rawQuery: unknown,
  options: ExportOptions
): Promise<{ rows: VendorCreditListRow[]; columns: typeof VENDOR_CREDIT_COLUMNS }> {
  const query = vendorCreditQueryStateSchema.parse(rawQuery);
  const where = buildWhere(query);
  const orderBy = buildSortOrderBy(query.sort);

  let rows: VendorCreditListRow[];

  try {
    if (options.scope === 'selected' && options.selectedIds && options.selectedIds.length > 0) {
      const selectedWhere = { ...where, id: { in: options.selectedIds } };
      const vendorCredits = await prisma.vendorCredit.findMany({
        where: selectedWhere,
        orderBy,
        take: Math.min(options.selectedIds.length, MAX_EXPORT_ROWS),
        select: LIST_SELECT,
      });
      rows = vendorCredits.map(toVendorCreditListRow);
    } else if (options.scope === 'current_page') {
      const skip =
        ((options.page ?? query.page) - MIN_PAGE) * (options.pageSize ?? query.page_size);
      const vendorCredits = await prisma.vendorCredit.findMany({
        where,
        orderBy,
        take: options.pageSize ?? query.page_size,
        skip,
        select: LIST_SELECT,
      });
      rows = vendorCredits.map(toVendorCreditListRow);
    } else {
      const vendorCredits = await prisma.vendorCredit.findMany({
        where,
        orderBy,
        take: MAX_EXPORT_ROWS,
        select: LIST_SELECT,
      });
      rows = vendorCredits.map(toVendorCreditListRow);
    }
  } catch (error) {
    if (isPrismaTableError(error)) {
      console.error('VendorCredit table not available — migration may not be applied:', error);
      rows = [];
    } else {
      throw error;
    }
  }

  const columns = getExportColumns(options.includeAllColumns ?? false);
  return { rows, columns };
}

export function buildCsv(
  rows: VendorCreditListRow[],
  columns: typeof VENDOR_CREDIT_COLUMNS
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
