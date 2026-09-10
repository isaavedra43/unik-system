import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { PACKAGE_COLUMNS, PACKAGE_COLUMN_MAP } from './packages-columns';
import {
  packageFilterGroupSchema,
  packageQueryStateSchema,
  type PackageFilterGroup,
  type PackageQueryState,
  type PackageSort,
  DATE_SHORTCUTS,
} from './packages-filters';
import { toPackageListRow, toPackageDetail } from './packages-contract';
import type { PackageListRow, PackageDetail } from './packages-contract';
import { formatDateOnly, getPackageStatusConfig } from './packages-helpers';

const MIN_PAGE = 1;
const MAX_EXPORT_ROWS = 50_000;

export type { PackageListRow, PackageDetail };

const LIST_SELECT = {
  id: true,
  packageNumber: true,
  status: true,
  date: true,
  carrier: true,
  trackingNumber: true,
  customerName: true,
  zohoSalesOrderId: true,
  sourceRemoteModifiedAt: true,
} satisfies Prisma.PackageSelect;

function resolveDateShortcut(shortcut: string): { from: Date; to: Date } | null {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);
  endOfDay.setMilliseconds(-1);
  switch (shortcut) {
    case 'today': return { from: startOfDay, to: endOfDay };
    case 'yesterday': {
      const from = new Date(startOfDay); from.setDate(from.getDate() - 1);
      const to = new Date(endOfDay); to.setDate(to.getDate() - 1);
      return { from, to };
    }
    case 'this_week': {
      const day = startOfDay.getDay();
      const from = new Date(startOfDay); from.setDate(from.getDate() - day);
      return { from, to: endOfDay };
    }
    case 'this_month': {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from, to: endOfDay };
    }
    case 'last_7_days': {
      const from = new Date(startOfDay); from.setDate(from.getDate() - 6);
      return { from, to: endOfDay };
    }
    case 'last_30_days': {
      const from = new Date(startOfDay); from.setDate(from.getDate() - 29);
      return { from, to: endOfDay };
    }
    default: return null;
  }
}

function parseDate(value: string | Date): Date | null {
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildRuleWhere(
  rule: z.infer<typeof packageFilterGroupSchema>['rules'][number]
): Prisma.PackageWhereInput {
  const column = PACKAGE_COLUMNS.find((c) => c.field === rule.field);
  if (!column) return {};
  const field = rule.field as keyof Prisma.PackageWhereInput;
  const type = column.type;

  switch (type) {
    case 'text': {
      const op = rule.operator as string;
      const val = 'value' in rule ? (rule.value as string | undefined) : undefined;
      if (op === 'is_empty') return { [field]: { equals: null } } as Prisma.PackageWhereInput;
      if (op === 'is_not_empty') return { [field]: { not: null } } as Prisma.PackageWhereInput;
      if (!val) return {};
      if (op === 'contains') return { [field]: { contains: val, mode: 'insensitive' } } as Prisma.PackageWhereInput;
      if (op === 'not_contains') return { [field]: { not: { contains: val, mode: 'insensitive' } } } as Prisma.PackageWhereInput;
      if (op === 'equals') return { [field]: { equals: val, mode: 'insensitive' } } as Prisma.PackageWhereInput;
      if (op === 'not_equals') return { [field]: { not: { equals: val, mode: 'insensitive' } } } as Prisma.PackageWhereInput;
      if (op === 'starts_with') return { [field]: { startsWith: val, mode: 'insensitive' } } as Prisma.PackageWhereInput;
      return {};
    }
    case 'status': {
      const op = rule.operator as string;
      const val = 'value' in rule ? rule.value : undefined;
      if (op === 'is_empty') return { [field]: { equals: null } } as Prisma.PackageWhereInput;
      if (op === 'equals') {
        if (typeof val !== 'string') return {};
        return { [field]: { equals: val, mode: 'insensitive' } } as Prisma.PackageWhereInput;
      }
      if (op === 'not_equals') {
        if (typeof val !== 'string') return {};
        return { [field]: { not: { equals: val, mode: 'insensitive' } } } as Prisma.PackageWhereInput;
      }
      if (op === 'in') {
        const arr = Array.isArray(val) ? val : typeof val === 'string' ? [val] : [];
        if (arr.length === 0) return {};
        return { [field]: { in: arr, mode: 'insensitive' } } as Prisma.PackageWhereInput;
      }
      if (op === 'not_in') {
        const arr = Array.isArray(val) ? val : typeof val === 'string' ? [val] : [];
        if (arr.length === 0) return {};
        return { [field]: { notIn: arr, mode: 'insensitive' } } as Prisma.PackageWhereInput;
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
      if (op === 'equals' && num !== null && !Number.isNaN(num)) return { [field]: { equals: num } } as Prisma.PackageWhereInput;
      if (op === 'greater_than' && num !== null && !Number.isNaN(num)) return { [field]: { gt: num } } as Prisma.PackageWhereInput;
      if (op === 'greater_or_equal' && num !== null && !Number.isNaN(num)) return { [field]: { gte: num } } as Prisma.PackageWhereInput;
      if (op === 'less_than' && num !== null && !Number.isNaN(num)) return { [field]: { lt: num } } as Prisma.PackageWhereInput;
      if (op === 'less_or_equal' && num !== null && !Number.isNaN(num)) return { [field]: { lte: num } } as Prisma.PackageWhereInput;
      if (op === 'between' && num !== null && numTo !== null && !Number.isNaN(num) && !Number.isNaN(numTo))
        return { [field]: { gte: num, lte: numTo } } as Prisma.PackageWhereInput;
      return {};
    }
    case 'date': {
      const op = rule.operator as string;
      const shortcut = 'shortcut' in rule ? rule.shortcut : undefined;
      const rawVal = 'value' in rule ? rule.value : undefined;
      const rawValTo = 'valueTo' in rule ? rule.valueTo : undefined;
      if (shortcut && DATE_SHORTCUTS.includes(shortcut as (typeof DATE_SHORTCUTS)[number])) {
        const range = resolveDateShortcut(shortcut);
        if (range) return { [field]: { gte: range.from, lte: range.to } } as Prisma.PackageWhereInput;
      }
      const val = rawVal ? parseDate(rawVal as string | Date) : null;
      const valTo = rawValTo ? parseDate(rawValTo as string | Date) : null;
      if (op === 'equals' && val) return { [field]: { equals: val } } as Prisma.PackageWhereInput;
      if (op === 'before' && val) return { [field]: { lt: val } } as Prisma.PackageWhereInput;
      if (op === 'after' && val) return { [field]: { gt: val } } as Prisma.PackageWhereInput;
      if (op === 'between' && val && valTo) return { [field]: { gte: val, lte: valTo } } as Prisma.PackageWhereInput;
      return {};
    }
    default: return {};
  }
}

function buildFilterWhere(filterGroup: PackageFilterGroup): Prisma.PackageWhereInput {
  if (!filterGroup.rules || filterGroup.rules.length === 0) return {};
  const conditions = filterGroup.rules.map(buildRuleWhere).filter((c) => Object.keys(c).length > 0);
  if (conditions.length === 0) return {};
  if (filterGroup.logic === 'OR') return { OR: conditions };
  return { AND: conditions };
}

function buildSearchWhere(search: string | undefined): Prisma.PackageWhereInput {
  if (!search || search.length === 0) return {};
  return {
    OR: [
      { packageNumber: { contains: search, mode: 'insensitive' } },
      { trackingNumber: { contains: search, mode: 'insensitive' } },
      { carrier: { contains: search, mode: 'insensitive' } },
      { customerName: { contains: search, mode: 'insensitive' } },
    ],
  };
}

function buildSortOrderBy(sort: PackageSort): Prisma.PackageOrderByWithRelationInput[] {
  if (!sort || sort.length === 0) return [{ packageNumber: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }];
  return sort.map((s) => ({ [s.field]: s.direction }) as Prisma.PackageOrderByWithRelationInput);
}

function buildWhere(query: PackageQueryState): Prisma.PackageWhereInput {
  const searchWhere = buildSearchWhere(query.search);
  const filterWhere = buildFilterWhere(query.filters);
  return { AND: [searchWhere, filterWhere].filter((w) => Object.keys(w).length > 0) };
}

export interface PackagesListResult {
  data: PackageListRow[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  aggregates: { count: number };
}

export async function getPackagesWorkspace(rawQuery: unknown): Promise<PackagesListResult> {
  const query = packageQueryStateSchema.parse(rawQuery);
  const where = buildWhere(query);
  const orderBy = buildSortOrderBy(query.sort);
  const skip = (query.page - MIN_PAGE) * query.page_size;

  const [packages, total] = await Promise.all([
    prisma.package.findMany({ where, orderBy, take: query.page_size, skip, select: LIST_SELECT }),
    prisma.package.count({ where }),
  ]);

  const totalPages = Math.ceil(total / query.page_size);
  return {
    data: packages.map(toPackageListRow),
    pagination: { page: query.page, page_size: query.page_size, total, total_pages: totalPages },
    aggregates: { count: total },
  };
}

export async function getPackageById(id: string): Promise<PackageDetail | null> {
  const pkg = await prisma.package.findUnique({
    where: { id },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!pkg) return null;
  return toPackageDetail(pkg);
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


function getExportColumns(includeAll: boolean): typeof PACKAGE_COLUMNS {
  if (includeAll) return PACKAGE_COLUMNS;
  return PACKAGE_COLUMNS.filter((c) => c.defaultVisible);
}

function formatExportValue(row: PackageListRow, columnId: string): string {
  const column = PACKAGE_COLUMN_MAP[columnId];
  if (!column) return '';
  const value = (row as unknown as Record<string, unknown>)[columnId];
  if (value === null || value === undefined) return '';
  if (column.formatter === 'date') return formatDateOnly(value as string | Date);
  if (column.formatter === 'statusDot') return getPackageStatusConfig(value as string | null).label;
  return String(value);
}

export async function getPackagesForExport(
  rawQuery: unknown,
  options: ExportOptions
): Promise<{ rows: PackageListRow[]; columns: typeof PACKAGE_COLUMNS }> {
  const query = packageQueryStateSchema.parse(rawQuery);
  const where = buildWhere(query);
  const orderBy = buildSortOrderBy(query.sort);
  let rows: PackageListRow[];

  if (options.scope === 'selected' && options.selectedIds && options.selectedIds.length > 0) {
    const selectedWhere = { ...where, id: { in: options.selectedIds } };
    const packages = await prisma.package.findMany({
      where: selectedWhere, orderBy,
      take: Math.min(options.selectedIds.length, MAX_EXPORT_ROWS),
      select: LIST_SELECT,
    });
    rows = packages.map(toPackageListRow);
  } else if (options.scope === 'current_page') {
    const skip = ((options.page ?? query.page) - MIN_PAGE) * (options.pageSize ?? query.page_size);
    const packages = await prisma.package.findMany({
      where, orderBy, take: options.pageSize ?? query.page_size, skip, select: LIST_SELECT,
    });
    rows = packages.map(toPackageListRow);
  } else {
    const packages = await prisma.package.findMany({
      where, orderBy, take: MAX_EXPORT_ROWS, select: LIST_SELECT,
    });
    rows = packages.map(toPackageListRow);
  }

  const columns = getExportColumns(options.includeAllColumns ?? false);
  return { rows, columns };
}

export function buildCsv(rows: PackageListRow[], columns: typeof PACKAGE_COLUMNS): string {
  const header = columns.map((c) => `"${c.label.replace(/"/g, '""')}"`).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => {
      const val = formatExportValue(row, c.id);
      return `"${val.replace(/"/g, '""')}"`;
    }).join(',')
  );
  return [header, ...lines].join('\r\n');
}
