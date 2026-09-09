import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { INVOICE_COLUMNS, INVOICE_COLUMN_MAP } from './invoices-columns';
import {
  invoiceFilterGroupSchema, invoiceQueryStateSchema,
  type InvoiceFilterGroup, type InvoiceQueryState, type InvoiceSort,
  DATE_SHORTCUTS,
} from './invoices-filters';
import { toInvoiceListRow, toInvoiceDetail } from './invoices-contract';
import type { InvoiceListRow, InvoiceDetail } from './invoices-contract';
import { formatCurrency, formatDateOnly, getInvoiceStatusConfig } from './invoices-helpers';

const MIN_PAGE = 1;
const MAX_EXPORT_ROWS = 50_000;
export type { InvoiceListRow, InvoiceDetail };

const LIST_SELECT = {
  id: true, invoiceNumber: true, status: true, date: true, dueDate: true,
  customerName: true, total: true, balance: true, currencyCode: true,
  sourceRemoteModifiedAt: true,
} satisfies Prisma.InvoiceSelect;

function resolveDateShortcut(shortcut: string): { from: Date; to: Date } | null {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay); endOfDay.setDate(endOfDay.getDate() + 1); endOfDay.setMilliseconds(-1);
  switch (shortcut) {
    case 'today': return { from: startOfDay, to: endOfDay };
    case 'yesterday': { const from = new Date(startOfDay); from.setDate(from.getDate() - 1); const to = new Date(endOfDay); to.setDate(to.getDate() - 1); return { from, to }; }
    case 'this_week': { const day = startOfDay.getDay(); const from = new Date(startOfDay); from.setDate(from.getDate() - day); return { from, to: endOfDay }; }
    case 'this_month': { const from = new Date(now.getFullYear(), now.getMonth(), 1); return { from, to: endOfDay }; }
    case 'last_7_days': { const from = new Date(startOfDay); from.setDate(from.getDate() - 6); return { from, to: endOfDay }; }
    case 'last_30_days': { const from = new Date(startOfDay); from.setDate(from.getDate() - 29); return { from, to: endOfDay }; }
    default: return null;
  }
}

function parseDate(value: string | Date): Date | null {
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildRuleWhere(rule: z.infer<typeof invoiceFilterGroupSchema>['rules'][number]): Prisma.InvoiceWhereInput {
  const column = INVOICE_COLUMNS.find((c) => c.field === rule.field);
  if (!column) return {};
  const field = rule.field as keyof Prisma.InvoiceWhereInput;
  const type = column.type;
  switch (type) {
    case 'text': {
      const op = rule.operator as string;
      const val = 'value' in rule ? (rule.value as string | undefined) : undefined;
      if (op === 'is_empty') return { [field]: { equals: null } } as Prisma.InvoiceWhereInput;
      if (op === 'is_not_empty') return { [field]: { not: null } } as Prisma.InvoiceWhereInput;
      if (!val) return {};
      if (op === 'contains') return { [field]: { contains: val, mode: 'insensitive' } } as Prisma.InvoiceWhereInput;
      if (op === 'not_contains') return { [field]: { not: { contains: val, mode: 'insensitive' } } } as Prisma.InvoiceWhereInput;
      if (op === 'equals') return { [field]: { equals: val, mode: 'insensitive' } } as Prisma.InvoiceWhereInput;
      if (op === 'not_equals') return { [field]: { not: { equals: val, mode: 'insensitive' } } } as Prisma.InvoiceWhereInput;
      if (op === 'starts_with') return { [field]: { startsWith: val, mode: 'insensitive' } } as Prisma.InvoiceWhereInput;
      return {};
    }
    case 'status': {
      const op = rule.operator as string;
      const val = 'value' in rule ? rule.value : undefined;
      if (op === 'is_empty') return { [field]: { equals: null } } as Prisma.InvoiceWhereInput;
      if (op === 'equals') { if (typeof val !== 'string') return {}; return { [field]: { equals: val, mode: 'insensitive' } } as Prisma.InvoiceWhereInput; }
      if (op === 'not_equals') { if (typeof val !== 'string') return {}; return { [field]: { not: { equals: val, mode: 'insensitive' } } } as Prisma.InvoiceWhereInput; }
      if (op === 'in') { const arr = Array.isArray(val) ? val : typeof val === 'string' ? [val] : []; if (arr.length === 0) return {}; return { [field]: { in: arr, mode: 'insensitive' } } as Prisma.InvoiceWhereInput; }
      if (op === 'not_in') { const arr = Array.isArray(val) ? val : typeof val === 'string' ? [val] : []; if (arr.length === 0) return {}; return { [field]: { notIn: arr, mode: 'insensitive' } } as Prisma.InvoiceWhereInput; }
      return {};
    }
    case 'number':
    case 'currency': {
      const op = rule.operator as string;
      const raw = 'value' in rule ? rule.value : undefined;
      const rawTo = 'valueTo' in rule ? rule.valueTo : undefined;
      const num = raw !== undefined && raw !== null && raw !== '' ? Number(raw) : null;
      const numTo = rawTo !== undefined && rawTo !== null && rawTo !== '' ? Number(rawTo) : null;
      if (op === 'equals' && num !== null && !Number.isNaN(num)) return { [field]: { equals: num } } as Prisma.InvoiceWhereInput;
      if (op === 'greater_than' && num !== null && !Number.isNaN(num)) return { [field]: { gt: num } } as Prisma.InvoiceWhereInput;
      if (op === 'greater_or_equal' && num !== null && !Number.isNaN(num)) return { [field]: { gte: num } } as Prisma.InvoiceWhereInput;
      if (op === 'less_than' && num !== null && !Number.isNaN(num)) return { [field]: { lt: num } } as Prisma.InvoiceWhereInput;
      if (op === 'less_or_equal' && num !== null && !Number.isNaN(num)) return { [field]: { lte: num } } as Prisma.InvoiceWhereInput;
      if (op === 'between' && num !== null && numTo !== null && !Number.isNaN(num) && !Number.isNaN(numTo)) return { [field]: { gte: num, lte: numTo } } as Prisma.InvoiceWhereInput;
      return {};
    }
    case 'date': {
      const op = rule.operator as string;
      const shortcut = 'shortcut' in rule ? rule.shortcut : undefined;
      const rawVal = 'value' in rule ? rule.value : undefined;
      const rawValTo = 'valueTo' in rule ? rule.valueTo : undefined;
      if (shortcut && DATE_SHORTCUTS.includes(shortcut as (typeof DATE_SHORTCUTS)[number])) {
        const range = resolveDateShortcut(shortcut);
        if (range) return { [field]: { gte: range.from, lte: range.to } } as Prisma.InvoiceWhereInput;
      }
      const val = rawVal ? parseDate(rawVal as string | Date) : null;
      const valTo = rawValTo ? parseDate(rawValTo as string | Date) : null;
      if (op === 'equals' && val) return { [field]: { equals: val } } as Prisma.InvoiceWhereInput;
      if (op === 'before' && val) return { [field]: { lt: val } } as Prisma.InvoiceWhereInput;
      if (op === 'after' && val) return { [field]: { gt: val } } as Prisma.InvoiceWhereInput;
      if (op === 'between' && val && valTo) return { [field]: { gte: val, lte: valTo } } as Prisma.InvoiceWhereInput;
      return {};
    }
    default: return {};
  }
}

function buildFilterWhere(filterGroup: InvoiceFilterGroup): Prisma.InvoiceWhereInput {
  if (!filterGroup.rules || filterGroup.rules.length === 0) return {};
  const conditions = filterGroup.rules.map(buildRuleWhere).filter((c) => Object.keys(c).length > 0);
  if (conditions.length === 0) return {};
  if (filterGroup.logic === 'OR') return { OR: conditions };
  return { AND: conditions };
}

function buildSearchWhere(search: string | undefined): Prisma.InvoiceWhereInput {
  if (!search || search.length === 0) return {};
  return { OR: [
    { invoiceNumber: { contains: search, mode: 'insensitive' } },
    { customerName: { contains: search, mode: 'insensitive' } },
  ] };
}

function buildSortOrderBy(sort: InvoiceSort): Prisma.InvoiceOrderByWithRelationInput[] {
  if (!sort || sort.length === 0) return [{ invoiceNumber: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }];
  return sort.map((s) => ({ [s.field]: s.direction }) as Prisma.InvoiceOrderByWithRelationInput);
}

function buildWhere(query: InvoiceQueryState): Prisma.InvoiceWhereInput {
  const searchWhere = buildSearchWhere(query.search);
  const filterWhere = buildFilterWhere(query.filters);
  return { AND: [searchWhere, filterWhere].filter((w) => Object.keys(w).length > 0) };
}

export interface InvoicesListResult {
  data: InvoiceListRow[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  aggregates: { count: number };
}

export async function getInvoicesWorkspace(rawQuery: unknown): Promise<InvoicesListResult> {
  const query = invoiceQueryStateSchema.parse(rawQuery);
  const where = buildWhere(query);
  const orderBy = buildSortOrderBy(query.sort);
  const skip = (query.page - MIN_PAGE) * query.page_size;
  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({ where, orderBy, take: query.page_size, skip, select: LIST_SELECT }),
    prisma.invoice.count({ where }),
  ]);
  const totalPages = Math.ceil(total / query.page_size);
  return { data: invoices.map(toInvoiceListRow), pagination: { page: query.page, page_size: query.page_size, total, total_pages: totalPages }, aggregates: { count: total } };
}

export async function getInvoiceById(id: string): Promise<InvoiceDetail | null> {
  const inv = await prisma.invoice.findUnique({ where: { id }, include: { items: { orderBy: { sortOrder: 'asc' } } } });
  if (!inv) return null;
  return toInvoiceDetail(inv);
}

export interface ExportOptions { format: 'csv' | 'xlsx'; scope: 'current_page' | 'selected' | 'filtered'; selectedIds?: string[]; includeAllColumns?: boolean; page?: number; pageSize?: number; }
export const EXPORT_COLUMN_IDS = INVOICE_COLUMNS.map((c) => c.id);

function getExportColumns(includeAll: boolean): typeof INVOICE_COLUMNS {
  if (includeAll) return INVOICE_COLUMNS;
  return INVOICE_COLUMNS.filter((c) => c.defaultVisible);
}

function formatExportValue(row: InvoiceListRow, columnId: string): string {
  const column = INVOICE_COLUMN_MAP[columnId];
  if (!column) return '';
  const value = (row as unknown as Record<string, unknown>)[columnId];
  if (value === null || value === undefined) return '';
  if (column.formatter === 'currency') return formatCurrency(value as string | number, row.currencyCode);
  if (column.formatter === 'date') return formatDateOnly(value as string | Date);
  if (column.formatter === 'statusDot') return getInvoiceStatusConfig(value as string | null).label;
  return String(value);
}

export async function getInvoicesForExport(rawQuery: unknown, options: ExportOptions): Promise<{ rows: InvoiceListRow[]; columns: typeof INVOICE_COLUMNS }> {
  const query = invoiceQueryStateSchema.parse(rawQuery);
  const where = buildWhere(query);
  const orderBy = buildSortOrderBy(query.sort);
  let rows: InvoiceListRow[];
  if (options.scope === 'selected' && options.selectedIds && options.selectedIds.length > 0) {
    const selectedWhere = { ...where, id: { in: options.selectedIds } };
    const invoices = await prisma.invoice.findMany({ where: selectedWhere, orderBy, take: Math.min(options.selectedIds.length, MAX_EXPORT_ROWS), select: LIST_SELECT });
    rows = invoices.map(toInvoiceListRow);
  } else if (options.scope === 'current_page') {
    const skip = ((options.page ?? query.page) - MIN_PAGE) * (options.pageSize ?? query.page_size);
    const invoices = await prisma.invoice.findMany({ where, orderBy, take: options.pageSize ?? query.page_size, skip, select: LIST_SELECT });
    rows = invoices.map(toInvoiceListRow);
  } else {
    const invoices = await prisma.invoice.findMany({ where, orderBy, take: MAX_EXPORT_ROWS, select: LIST_SELECT });
    rows = invoices.map(toInvoiceListRow);
  }
  const columns = getExportColumns(options.includeAllColumns ?? false);
  return { rows, columns };
}

export function buildCsv(rows: InvoiceListRow[], columns: typeof INVOICE_COLUMNS): string {
  const header = columns.map((c) => `"${c.label.replace(/"/g, '""')}"`).join(',');
  const lines = rows.map((row) => columns.map((c) => { const val = formatExportValue(row, c.id); return `"${val.replace(/"/g, '""')}"`; }).join(','));
  return [header, ...lines].join('\r\n');
}
