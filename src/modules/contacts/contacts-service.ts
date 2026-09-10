import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { CONTACT_COLUMNS, CONTACT_COLUMN_MAP } from './contacts-columns';
import {
  contactFilterGroupSchema,
  contactQueryStateSchema,
  type ContactFilterGroup,
  type ContactQueryState,
  type ContactSort,
  DATE_SHORTCUTS,
} from './contacts-filters';
import { toContactListRow, toContactDetail } from './contacts-contract';
import type { ContactListRow, ContactDetail } from './contacts-contract';
import { formatCurrency, formatDateOnly, getContactStatusConfig } from './contacts-helpers';

const MIN_PAGE = 1;
const MAX_EXPORT_ROWS = 50_000;

export type { ContactListRow, ContactDetail };

const LIST_SELECT = {
  id: true,
  contactType: true,
  contactName: true,
  companyName: true,
  status: true,
  currencyCode: true,
  paymentTermsLabel: true,
  primaryEmail: true,
  primaryPhone: true,
  website: true,
  outstandingReceivable: true,
  outstandingPayable: true,
  sourceRemoteModifiedAt: true,
} satisfies Prisma.ContactSelect;

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
  rule: z.infer<typeof contactFilterGroupSchema>['rules'][number]
): Prisma.ContactWhereInput {
  const column = CONTACT_COLUMNS.find((c) => c.field === rule.field);
  if (!column) return {};

  const field = rule.field as keyof Prisma.ContactWhereInput;
  const type = column.type;

  switch (type) {
    case 'text': {
      const op = rule.operator as string;
      const val = 'value' in rule ? (rule.value as string | undefined) : undefined;
      if (op === 'is_empty') return { [field]: { equals: null } } as Prisma.ContactWhereInput;
      if (op === 'is_not_empty') return { [field]: { not: null } } as Prisma.ContactWhereInput;
      if (!val) return {};
      if (op === 'contains')
        return { [field]: { contains: val, mode: 'insensitive' } } as Prisma.ContactWhereInput;
      if (op === 'not_contains')
        return {
          [field]: { not: { contains: val, mode: 'insensitive' } },
        } as Prisma.ContactWhereInput;
      if (op === 'equals')
        return { [field]: { equals: val, mode: 'insensitive' } } as Prisma.ContactWhereInput;
      if (op === 'not_equals')
        return {
          [field]: { not: { equals: val, mode: 'insensitive' } },
        } as Prisma.ContactWhereInput;
      if (op === 'starts_with')
        return { [field]: { startsWith: val, mode: 'insensitive' } } as Prisma.ContactWhereInput;
      return {};
    }
    case 'status': {
      const op = rule.operator as string;
      const val = 'value' in rule ? rule.value : undefined;
      if (op === 'is_empty') return { [field]: { equals: null } } as Prisma.ContactWhereInput;
      if (op === 'equals') {
        if (typeof val !== 'string') return {};
        return { [field]: { equals: val, mode: 'insensitive' } } as Prisma.ContactWhereInput;
      }
      if (op === 'not_equals') {
        if (typeof val !== 'string') return {};
        return {
          [field]: { not: { equals: val, mode: 'insensitive' } },
        } as Prisma.ContactWhereInput;
      }
      if (op === 'in') {
        const arr = Array.isArray(val) ? val : typeof val === 'string' ? [val] : [];
        if (arr.length === 0) return {};
        return { [field]: { in: arr, mode: 'insensitive' } } as Prisma.ContactWhereInput;
      }
      if (op === 'not_in') {
        const arr = Array.isArray(val) ? val : typeof val === 'string' ? [val] : [];
        if (arr.length === 0) return {};
        return {
          [field]: { notIn: arr, mode: 'insensitive' },
        } as Prisma.ContactWhereInput;
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
        return { [field]: { equals: num } } as Prisma.ContactWhereInput;
      if (op === 'greater_than' && num !== null && !Number.isNaN(num))
        return { [field]: { gt: num } } as Prisma.ContactWhereInput;
      if (op === 'greater_or_equal' && num !== null && !Number.isNaN(num))
        return { [field]: { gte: num } } as Prisma.ContactWhereInput;
      if (op === 'less_than' && num !== null && !Number.isNaN(num))
        return { [field]: { lt: num } } as Prisma.ContactWhereInput;
      if (op === 'less_or_equal' && num !== null && !Number.isNaN(num))
        return { [field]: { lte: num } } as Prisma.ContactWhereInput;
      if (
        op === 'between' &&
        num !== null &&
        numTo !== null &&
        !Number.isNaN(num) &&
        !Number.isNaN(numTo)
      )
        return { [field]: { gte: num, lte: numTo } } as Prisma.ContactWhereInput;
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
          return { [field]: { gte: range.from, lte: range.to } } as Prisma.ContactWhereInput;
      }

      const val = rawVal ? parseDate(rawVal as string | Date) : null;
      const valTo = rawValTo ? parseDate(rawValTo as string | Date) : null;
      if (op === 'equals' && val)
        return { [field]: { equals: val } } as Prisma.ContactWhereInput;
      if (op === 'before' && val) return { [field]: { lt: val } } as Prisma.ContactWhereInput;
      if (op === 'after' && val) return { [field]: { gt: val } } as Prisma.ContactWhereInput;
      if (op === 'between' && val && valTo)
        return { [field]: { gte: val, lte: valTo } } as Prisma.ContactWhereInput;
      return {};
    }
    case 'boolean': {
      const op = rule.operator as string;
      const val = 'value' in rule ? rule.value : undefined;
      if (op === 'equals' && typeof val === 'boolean')
        return { [field]: { equals: val } } as Prisma.ContactWhereInput;
      return {};
    }
    default:
      return {};
  }
}

function buildFilterWhere(filterGroup: ContactFilterGroup): Prisma.ContactWhereInput {
  if (!filterGroup.rules || filterGroup.rules.length === 0) return {};
  const conditions = filterGroup.rules.map(buildRuleWhere).filter((c) => Object.keys(c).length > 0);
  if (conditions.length === 0) return {};
  if (filterGroup.logic === 'OR') return { OR: conditions };
  return { AND: conditions };
}

function buildSearchWhere(search: string | undefined): Prisma.ContactWhereInput {
  if (!search || search.length === 0) return {};
  return {
    OR: [
      { contactName: { contains: search, mode: 'insensitive' } },
      { companyName: { contains: search, mode: 'insensitive' } },
      { primaryEmail: { contains: search, mode: 'insensitive' } },
      { primaryPhone: { contains: search, mode: 'insensitive' } },
    ],
  };
}

function buildSortOrderBy(sort: ContactSort): Prisma.ContactOrderByWithRelationInput[] {
  if (!sort || sort.length === 0) {
    return [{ contactName: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }];
  }
  return sort.map(
    (s) => ({ [s.field]: s.direction }) as Prisma.ContactOrderByWithRelationInput
  );
}

function buildWhere(query: ContactQueryState, contactType: 'customer' | 'vendor'): Prisma.ContactWhereInput {
  const searchWhere = buildSearchWhere(query.search);
  const filterWhere = buildFilterWhere(query.filters);
  // Case-insensitive match on contactType. Also include contacts where
  // Zoho returned 'both' (contact is both customer and vendor) or null
  // (Zoho sometimes omits contact_type — we don't want to lose them).
  const typeWhere: Prisma.ContactWhereInput = {
    OR: [
      { contactType: { equals: contactType, mode: 'insensitive' } },
      { contactType: { equals: 'both', mode: 'insensitive' } },
      { contactType: null },
    ],
  };
  return {
    AND: [typeWhere, searchWhere, filterWhere].filter((w) => Object.keys(w).length > 0),
  };
}

// ---------------------------------------------------------------------------
// Public query functions
// ---------------------------------------------------------------------------

export interface ContactsListResult {
  data: ContactListRow[];
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
  aggregates: {
    count: number;
  };
}

export async function getContactsWorkspace(
  rawQuery: unknown,
  contactType: 'customer' | 'vendor'
): Promise<ContactsListResult> {
  const query = contactQueryStateSchema.parse(rawQuery);
  const where = buildWhere(query, contactType);
  const orderBy = buildSortOrderBy(query.sort);
  const skip = (query.page - MIN_PAGE) * query.page_size;

  const [contacts, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy,
      take: query.page_size,
      skip,
      select: LIST_SELECT,
    }),
    prisma.contact.count({ where }),
  ]);

  const totalPages = Math.ceil(total / query.page_size);

  return {
    data: contacts.map(toContactListRow),
    pagination: {
      page: query.page,
      page_size: query.page_size,
      total,
      total_pages: totalPages,
    },
    aggregates: {
      count: total,
    },
  };
}

export async function getContactById(id: string): Promise<ContactDetail | null> {
  const contact = await prisma.contact.findUnique({
    where: { id },
  });

  if (!contact) return null;

  return toContactDetail(contact);
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


function getExportColumns(includeAll: boolean): typeof CONTACT_COLUMNS {
  if (includeAll) return CONTACT_COLUMNS;
  return CONTACT_COLUMNS.filter((c) => c.defaultVisible);
}

function formatExportValue(row: ContactListRow, columnId: string): string {
  const column = CONTACT_COLUMN_MAP[columnId];
  if (!column) return '';
  const value = (row as unknown as Record<string, unknown>)[columnId];
  if (value === null || value === undefined) return '';
  if (column.formatter === 'currency')
    return formatCurrency(value as string | number, row.currencyCode);
  if (column.formatter === 'date') return formatDateOnly(value as string | Date);
  if (column.formatter === 'statusDot') {
    return getContactStatusConfig(value as string | null).label;
  }
  return String(value);
}

export async function getContactsForExport(
  rawQuery: unknown,
  contactType: 'customer' | 'vendor',
  options: ExportOptions
): Promise<{ rows: ContactListRow[]; columns: typeof CONTACT_COLUMNS }> {
  const query = contactQueryStateSchema.parse(rawQuery);
  const where = buildWhere(query, contactType);
  const orderBy = buildSortOrderBy(query.sort);

  let rows: ContactListRow[];

  if (options.scope === 'selected' && options.selectedIds && options.selectedIds.length > 0) {
    const selectedWhere = { ...where, id: { in: options.selectedIds } };
    const contacts = await prisma.contact.findMany({
      where: selectedWhere,
      orderBy,
      take: Math.min(options.selectedIds.length, MAX_EXPORT_ROWS),
      select: LIST_SELECT,
    });
    rows = contacts.map(toContactListRow);
  } else if (options.scope === 'current_page') {
    const skip = ((options.page ?? query.page) - MIN_PAGE) * (options.pageSize ?? query.page_size);
    const contacts = await prisma.contact.findMany({
      where,
      orderBy,
      take: options.pageSize ?? query.page_size,
      skip,
      select: LIST_SELECT,
    });
    rows = contacts.map(toContactListRow);
  } else {
    const contacts = await prisma.contact.findMany({
      where,
      orderBy,
      take: MAX_EXPORT_ROWS,
      select: LIST_SELECT,
    });
    rows = contacts.map(toContactListRow);
  }

  const columns = getExportColumns(options.includeAllColumns ?? false);
  return { rows, columns };
}

export function buildCsv(rows: ContactListRow[], columns: typeof CONTACT_COLUMNS): string {
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
