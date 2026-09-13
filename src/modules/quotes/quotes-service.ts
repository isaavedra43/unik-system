import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { QUOTE_COLUMNS, QUOTE_COLUMN_MAP } from './quotes-columns';
import {
  quoteFilterGroupSchema, quoteQueryStateSchema,
  type QuoteFilterGroup, type QuoteQueryState, type QuoteSort, type QuoteSegment,
  DATE_SHORTCUTS,
} from './quotes-filters';
import { toQuoteListRow, toQuoteDetail } from './quotes-contract';
import type { QuoteListRow, QuoteDetail } from './quotes-contract';
import { formatCurrency, formatDateOnly, getQuoteStatusConfig, getQuoteExpiryInfo } from './quotes-helpers';

const MIN_PAGE = 1;
const MAX_EXPORT_ROWS = 50_000;
export type { QuoteListRow, QuoteDetail };

const LIST_SELECT = {
  id: true, estimateNumber: true, referenceNumber: true, status: true, date: true, expiryDate: true,
  customerName: true, salespersonName: true, total: true, currencyCode: true, createdInUnik: true,
  sourceRemoteModifiedAt: true,
} satisfies Prisma.QuoteSelect;

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

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
    case 'next_7_days': { const to = new Date(endOfDay); to.setDate(to.getDate() + 7); return { from: startOfDay, to }; }
    case 'next_30_days': { const to = new Date(endOfDay); to.setDate(to.getDate() + 30); return { from: startOfDay, to }; }
    default: return null;
  }
}

function parseDate(value: string | Date): Date | null {
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

type W = Prisma.QuoteWhereInput;

function buildRuleWhere(rule: z.infer<typeof quoteFilterGroupSchema>['rules'][number]): W {
  const column = QUOTE_COLUMNS.find((c) => c.field === rule.field);
  if (!column) return {};
  const field = rule.field as keyof W;
  switch (column.type) {
    case 'text': {
      const op = rule.operator as string;
      const val = 'value' in rule ? (rule.value as string | undefined) : undefined;
      if (op === 'is_empty') return { [field]: { equals: null } } as W;
      if (op === 'is_not_empty') return { [field]: { not: null } } as W;
      if (!val) return {};
      if (op === 'contains') return { [field]: { contains: val, mode: 'insensitive' } } as W;
      if (op === 'not_contains') return { [field]: { not: { contains: val, mode: 'insensitive' } } } as W;
      if (op === 'equals') return { [field]: { equals: val, mode: 'insensitive' } } as W;
      if (op === 'not_equals') return { [field]: { not: { equals: val, mode: 'insensitive' } } } as W;
      if (op === 'starts_with') return { [field]: { startsWith: val, mode: 'insensitive' } } as W;
      return {};
    }
    case 'status': {
      const op = rule.operator as string;
      const val = 'value' in rule ? rule.value : undefined;
      if (op === 'is_empty') return { [field]: { equals: null } } as W;
      if (op === 'equals') { if (typeof val !== 'string') return {}; return { [field]: { equals: val, mode: 'insensitive' } } as W; }
      if (op === 'not_equals') { if (typeof val !== 'string') return {}; return { [field]: { not: { equals: val, mode: 'insensitive' } } } as W; }
      if (op === 'in') { const arr = Array.isArray(val) ? val : typeof val === 'string' ? [val] : []; if (arr.length === 0) return {}; return { [field]: { in: arr, mode: 'insensitive' } } as W; }
      if (op === 'not_in') { const arr = Array.isArray(val) ? val : typeof val === 'string' ? [val] : []; if (arr.length === 0) return {}; return { [field]: { notIn: arr, mode: 'insensitive' } } as W; }
      return {};
    }
    case 'number':
    case 'currency': {
      const op = rule.operator as string;
      const raw = 'value' in rule ? rule.value : undefined;
      const rawTo = 'valueTo' in rule ? rule.valueTo : undefined;
      const num = raw !== undefined && raw !== null && raw !== '' ? Number(raw) : null;
      const numTo = rawTo !== undefined && rawTo !== null && rawTo !== '' ? Number(rawTo) : null;
      if (num === null || Number.isNaN(num)) return {};
      if (op === 'equals') return { [field]: { equals: num } } as W;
      if (op === 'greater_than') return { [field]: { gt: num } } as W;
      if (op === 'greater_or_equal') return { [field]: { gte: num } } as W;
      if (op === 'less_than') return { [field]: { lt: num } } as W;
      if (op === 'less_or_equal') return { [field]: { lte: num } } as W;
      if (op === 'between' && numTo !== null && !Number.isNaN(numTo)) return { [field]: { gte: num, lte: numTo } } as W;
      return {};
    }
    case 'date': {
      const op = rule.operator as string;
      const shortcut = 'shortcut' in rule ? rule.shortcut : undefined;
      const rawVal = 'value' in rule ? rule.value : undefined;
      const rawValTo = 'valueTo' in rule ? rule.valueTo : undefined;
      if (shortcut && DATE_SHORTCUTS.includes(shortcut as (typeof DATE_SHORTCUTS)[number])) {
        const range = resolveDateShortcut(shortcut);
        if (range) return { [field]: { gte: range.from, lte: range.to } } as W;
      }
      const val = rawVal ? parseDate(rawVal as string | Date) : null;
      const valTo = rawValTo ? parseDate(rawValTo as string | Date) : null;
      if (op === 'equals' && val) return { [field]: { equals: val } } as W;
      if (op === 'before' && val) return { [field]: { lt: val } } as W;
      if (op === 'after' && val) return { [field]: { gt: val } } as W;
      if (op === 'between' && val && valTo) return { [field]: { gte: val, lte: valTo } } as W;
      return {};
    }
    default: return {};
  }
}

function buildFilterWhere(filterGroup: QuoteFilterGroup): W {
  if (!filterGroup.rules || filterGroup.rules.length === 0) return {};
  const conditions = filterGroup.rules.map(buildRuleWhere).filter((c) => Object.keys(c).length > 0);
  if (conditions.length === 0) return {};
  if (filterGroup.logic === 'OR') return { OR: conditions };
  return { AND: conditions };
}

function buildSearchWhere(search: string | undefined): W {
  if (!search || search.length === 0) return {};
  return { OR: [
    { estimateNumber: { contains: search, mode: 'insensitive' } },
    { referenceNumber: { contains: search, mode: 'insensitive' } },
    { customerName: { contains: search, mode: 'insensitive' } },
    { salespersonName: { contains: search, mode: 'insensitive' } },
    { items: { some: { OR: [
      { name: { contains: search, mode: 'insensitive' } },
      { sku: { contains: search, mode: 'insensitive' } },
    ] } } },
  ] };
}

const OPEN_STATUSES = ['draft', 'sent', 'expired'];
const CLOSED_STATUSES = ['accepted', 'declined', 'invoiced'];

export function buildSegmentWhere(segment: QuoteSegment, userId?: string | null): W {
  const today = startOfTodayUtc();
  switch (segment) {
    case 'open': return { status: { in: OPEN_STATUSES, mode: 'insensitive' } };
    case 'expiring': {
      const to = new Date(today); to.setUTCDate(to.getUTCDate() + 7);
      return { status: { in: ['draft', 'sent'], mode: 'insensitive' }, expiryDate: { gte: today, lte: to } };
    }
    case 'expired': return {
      OR: [
        { status: { equals: 'expired', mode: 'insensitive' } },
        { expiryDate: { lt: today }, status: { notIn: CLOSED_STATUSES, mode: 'insensitive' } },
      ],
    };
    case 'accepted': return { status: { equals: 'accepted', mode: 'insensitive' } };
    case 'declined': return { status: { equals: 'declined', mode: 'insensitive' } };
    case 'invoiced': return { status: { equals: 'invoiced', mode: 'insensitive' } };
    case 'mine': return userId
      ? { OR: [{ createdByUserId: userId }, { lastEditedByUserId: userId }] }
      : { createdInUnik: true };
    default: return {};
  }
}

function buildSortOrderBy(sort: QuoteSort): Prisma.QuoteOrderByWithRelationInput[] {
  if (!sort || sort.length === 0) return [{ date: 'desc' }, { estimateNumber: 'desc' }, { id: 'desc' }];
  return sort.map((s) => ({ [s.field]: s.direction }) as Prisma.QuoteOrderByWithRelationInput);
}

function buildWhere(query: QuoteQueryState, userId?: string | null): W {
  const searchWhere = buildSearchWhere(query.search);
  const filterWhere = buildFilterWhere(query.filters);
  const segmentWhere = buildSegmentWhere(query.segment, userId);
  return { AND: [searchWhere, filterWhere, segmentWhere].filter((w) => Object.keys(w).length > 0) };
}

export interface QuotesListResult {
  data: QuoteListRow[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  aggregates: { count: number; totalAmount: string | null };
}

export async function getQuotesWorkspace(rawQuery: unknown, userId?: string | null): Promise<QuotesListResult> {
  const query = quoteQueryStateSchema.parse(rawQuery);
  const where = buildWhere(query, userId);
  const orderBy = buildSortOrderBy(query.sort);
  const skip = (query.page - MIN_PAGE) * query.page_size;
  const [quotes, total, sum] = await Promise.all([
    prisma.quote.findMany({ where, orderBy, take: query.page_size, skip, select: LIST_SELECT }),
    prisma.quote.count({ where }),
    prisma.quote.aggregate({ where, _sum: { total: true } }),
  ]);
  const rows = quotes.map(toQuoteListRow);
  const totalPages = Math.ceil(total / query.page_size);
  return {
    data: rows,
    pagination: { page: query.page, page_size: query.page_size, total, total_pages: totalPages },
    aggregates: { count: total, totalAmount: sum._sum.total?.toString() ?? null },
  };
}

/** Counts per lifecycle segment for the workspace header chips. */
export async function getQuoteSegmentCounts(userId?: string | null): Promise<Record<QuoteSegment, number>> {
  const segments: QuoteSegment[] = ['all', 'open', 'expiring', 'expired', 'accepted', 'declined', 'invoiced', 'mine'];
  const counts = await Promise.all(segments.map((s) => prisma.quote.count({ where: buildSegmentWhere(s, userId) })));
  return Object.fromEntries(segments.map((s, i) => [s, counts[i]])) as Record<QuoteSegment, number>;
}

export async function getQuoteById(id: string): Promise<QuoteDetail | null> {
  const q = await prisma.quote.findUnique({ where: { id }, include: { items: { orderBy: { sortOrder: 'asc' } } } });
  if (!q) return null;
  return toQuoteDetail(q);
}

export async function getQuoteByZohoId(zohoEstimateId: string): Promise<QuoteDetail | null> {
  const q = await prisma.quote.findUnique({ where: { zohoEstimateId }, include: { items: { orderBy: { sortOrder: 'asc' } } } });
  if (!q) return null;
  return toQuoteDetail(q);
}

export interface ExportOptions { format: 'csv' | 'xlsx'; scope: 'current_page' | 'selected' | 'filtered'; selectedIds?: string[]; includeAllColumns?: boolean; page?: number; pageSize?: number; }

function getExportColumns(includeAll: boolean): typeof QUOTE_COLUMNS {
  if (includeAll) return QUOTE_COLUMNS;
  return QUOTE_COLUMNS.filter((c) => c.defaultVisible);
}

export function formatExportValue(row: QuoteListRow, columnId: string): string {
  const column = QUOTE_COLUMN_MAP[columnId];
  if (!column) return '';
  const value = (row as unknown as Record<string, unknown>)[columnId];
  if (value === null || value === undefined) return '';
  if (column.formatter === 'currency') return formatCurrency(value as string | number, row.currencyCode);
  if (column.formatter === 'date') return formatDateOnly(value as string | Date);
  if (column.formatter === 'expiry') {
    const info = getQuoteExpiryInfo(value as string, row.status);
    return info ? `${formatDateOnly(value as string)} (${info.label})` : formatDateOnly(value as string);
  }
  if (column.formatter === 'statusDot') return getQuoteStatusConfig(value as string | null).label;
  if (column.formatter === 'origin') return value ? 'UNIK' : 'Zoho';
  return String(value);
}

export async function getQuotesForExport(rawQuery: unknown, options: ExportOptions, userId?: string | null): Promise<{ rows: QuoteListRow[]; columns: typeof QUOTE_COLUMNS }> {
  const query = quoteQueryStateSchema.parse(rawQuery);
  const where = buildWhere(query, userId);
  const orderBy = buildSortOrderBy(query.sort);
  let rows: QuoteListRow[];
  if (options.scope === 'selected' && options.selectedIds && options.selectedIds.length > 0) {
    const selectedWhere = { ...where, id: { in: options.selectedIds } };
    const quotes = await prisma.quote.findMany({ where: selectedWhere, orderBy, take: Math.min(options.selectedIds.length, MAX_EXPORT_ROWS), select: LIST_SELECT });
    rows = quotes.map(toQuoteListRow);
  } else if (options.scope === 'current_page') {
    const skip = ((options.page ?? query.page) - MIN_PAGE) * (options.pageSize ?? query.page_size);
    const quotes = await prisma.quote.findMany({ where, orderBy, take: options.pageSize ?? query.page_size, skip, select: LIST_SELECT });
    rows = quotes.map(toQuoteListRow);
  } else {
    const quotes = await prisma.quote.findMany({ where, orderBy, take: MAX_EXPORT_ROWS, select: LIST_SELECT });
    rows = quotes.map(toQuoteListRow);
  }
  const columns = getExportColumns(options.includeAllColumns ?? false);
  return { rows, columns };
}

export function buildCsv(rows: QuoteListRow[], columns: typeof QUOTE_COLUMNS): string {
  const header = columns.map((c) => `"${c.label.replace(/"/g, '""')}"`).join(',');
  const lines = rows.map((row) => columns.map((c) => { const val = formatExportValue(row, c.id); return `"${val.replace(/"/g, '""')}"`; }).join(','));
  return [header, ...lines].join('\r\n');
}

// ---------------------------------------------------------------------------
// Lookups used by the create/edit form (and later by the AI tools)
// ---------------------------------------------------------------------------

export interface CustomerLookupRow {
  zohoContactId: string;
  contactName: string | null;
  companyName: string | null;
  primaryEmail: string | null;
  currencyCode: string | null;
  status: string | null;
}

export async function searchCustomersForQuote(search: string, limit = 20): Promise<CustomerLookupRow[]> {
  const term = search.trim();
  const where: Prisma.ContactWhereInput = {
    contactType: { equals: 'customer', mode: 'insensitive' },
    ...(term.length > 0
      ? { OR: [
          { contactName: { contains: term, mode: 'insensitive' } },
          { companyName: { contains: term, mode: 'insensitive' } },
          { primaryEmail: { contains: term, mode: 'insensitive' } },
          { zohoContactId: { equals: term } },
        ] }
      : {}),
  };
  const rows = await prisma.contact.findMany({
    where, take: Math.min(limit, 50), orderBy: [{ contactName: 'asc' }],
    select: { zohoContactId: true, contactName: true, companyName: true, primaryEmail: true, currencyCode: true, status: true },
  });
  return rows;
}

export interface ProductLookupRow {
  zohoItemId: string;
  name: string | null;
  sku: string | null;
  description: string | null;
  rate: string | null;
  unit: string | null;
  taxName: string | null;
  taxPercentage: string | null;
  availableStock: string | null;
  status: string | null;
}

export async function searchProductsForQuote(search: string, limit = 20): Promise<ProductLookupRow[]> {
  const term = search.trim();
  const where: Prisma.ProductWhereInput = term.length > 0
    ? { OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { sku: { contains: term, mode: 'insensitive' } },
        { zohoItemId: { equals: term } },
      ] }
    : {};
  const rows = await prisma.product.findMany({
    where, take: Math.min(limit, 50), orderBy: [{ name: 'asc' }],
    select: { zohoItemId: true, name: true, sku: true, description: true, rate: true, unit: true, taxName: true, taxPercentage: true, availableStock: true, status: true },
  });
  return rows.map((r) => ({
    zohoItemId: r.zohoItemId, name: r.name, sku: r.sku, description: r.description,
    rate: r.rate?.toString() ?? null, unit: r.unit, taxName: r.taxName,
    taxPercentage: r.taxPercentage?.toString() ?? null, availableStock: r.availableStock?.toString() ?? null,
    status: r.status,
  }));
}

export async function getCustomerForQuote(zohoContactId: string): Promise<CustomerLookupRow | null> {
  return prisma.contact.findUnique({
    where: { zohoContactId },
    select: { zohoContactId: true, contactName: true, companyName: true, primaryEmail: true, currencyCode: true, status: true },
  });
}
