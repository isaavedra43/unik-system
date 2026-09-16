import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  CASE_RISK_LABELS,
  caseRisk,
  isOpenCaseStatus,
  type CaseRiskLevel,
} from '@/components/operations/case/case-model';
import { CASE_COLUMNS, type CaseRow } from '@/components/operations/case/cases-columns';
import {
  CasesQueryError,
  type CaseFilterRule,
  type CaseQueryState,
} from '@/components/operations/case/cases-filters';
import { dateShortcutRange } from '@/modules/areas/work-rows-sql';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import {
  AREA_LABELS,
  AREA_REQUEST_OPEN_STATUSES,
  CASE_OPEN_STATUSES,
  CASE_PHASE_LABELS,
  CASE_STATUS_LABELS,
  INCIDENT_OPEN_STATUSES,
  PRIORITY_LABELS,
  WORK_ITEM_OPEN_STATUSES,
  isAreaKey,
} from '@/modules/operations/types';
import { DATE_SHORTCUTS, type EntityListResult } from '@/modules/shared/entity-workspace-types';

/**
 * Server queries of the case list (`/app/operations`, plan 2.7).
 *
 * WHITE LIST: only the columns declared in `cases-columns.ts` can be filtered
 * or sorted, and `cases-filters.ts` already rejected anything else with a 422.
 * Here every value a person typed travels as a Prisma parameter — no string of
 * theirs ever becomes a column name.
 *
 * ACCESS: `operations.view` sees every case; anybody else only the cases they
 * own (the same rule `listCases` applies in the core). Opening ONE case is
 * stricter and lives in `_case-data.ts` (`authorizeOperationsChannel`).
 */

const VIEW_PERMISSION = 'operations.view';
/** Cap of the pre-query that resolves risk and blocking area (operationally small sets). */
const SCAN_LIMIT = 5000;
const EXPORT_LIMIT = 2000;

const FILTERABLE_COLUMNS = new Map(
  CASE_COLUMNS.filter((column) => column.filterable).map((column) => [column.field, column])
);
const SORTABLE_FIELDS = new Set(
  CASE_COLUMNS.filter((column) => column.sortable).map((column) => column.field)
);

type Where = Prisma.OperationalCaseWhereInput;

// ---------------------------------------------------------------------------
// Filter rules → Prisma
// ---------------------------------------------------------------------------

function textValue(rule: CaseFilterRule): string {
  if (typeof rule.value === 'string') return rule.value.trim();
  if (typeof rule.value === 'number') return String(rule.value);
  return '';
}

function textWhere(field: string, rule: CaseFilterRule): Where {
  if (rule.operator === 'is_empty') return { OR: [{ [field]: null }, { [field]: '' }] } as Where;
  if (rule.operator === 'is_not_empty') {
    return { AND: [{ [field]: { not: null } }, { [field]: { not: '' } }] } as Where;
  }
  const value = textValue(rule);
  if (!value) return {};
  const ci = { mode: 'insensitive' as const };
  switch (rule.operator) {
    case 'contains':
      return { [field]: { contains: value, ...ci } } as Where;
    case 'not_contains':
      return { OR: [{ [field]: null }, { NOT: { [field]: { contains: value, ...ci } } }] } as Where;
    case 'equals':
      return { [field]: { equals: value, ...ci } } as Where;
    case 'not_equals':
      return { OR: [{ [field]: null }, { NOT: { [field]: { equals: value, ...ci } } }] } as Where;
    case 'starts_with':
      return { [field]: { startsWith: value, ...ci } } as Where;
    default:
      return {};
  }
}

function statusList(rule: CaseFilterRule): string[] {
  if (Array.isArray(rule.value))
    return rule.value.map((entry) => String(entry).trim()).filter(Boolean);
  const single = textValue(rule);
  return single ? [single] : [];
}

function statusWhere(field: string, rule: CaseFilterRule): Where {
  if (rule.operator === 'is_empty') return { OR: [{ [field]: null }, { [field]: '' }] } as Where;
  const values = statusList(rule);
  if (values.length === 0) return {};
  switch (rule.operator) {
    case 'equals':
    case 'in':
      return { [field]: { in: values } } as Where;
    case 'not_equals':
    case 'not_in':
      return { NOT: { [field]: { in: values } } } as Where;
    default:
      return {};
  }
}

/** Parses `YYYY-MM-DD` (or any ISO string) to the start of that calendar day. */
function parseDay(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 0, 0, 0, 0);
}

function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function dateWhere(field: string, rule: CaseFilterRule, now: Date): Where {
  if (rule.shortcut && (DATE_SHORTCUTS as readonly string[]).includes(rule.shortcut)) {
    const range = dateShortcutRange(rule.shortcut, now);
    if (range) return { [field]: { gte: range.from, lte: range.to } } as Where;
  }
  const from = parseDay(rule.value);
  const to = parseDay(rule.valueTo);
  switch (rule.operator) {
    case 'equals':
      return from ? ({ [field]: { gte: from, lte: endOfDay(from) } } as Where) : {};
    case 'before':
      return from ? ({ [field]: { lt: from } } as Where) : {};
    case 'after':
      return from ? ({ [field]: { gt: endOfDay(from) } } as Where) : {};
    case 'between': {
      if (!from || !to) return {};
      const [low, high] = from <= to ? [from, to] : [to, from];
      return { [field]: { gte: low, lte: endOfDay(high) } } as Where;
    }
    default:
      return {};
  }
}

function ruleWhere(rule: CaseFilterRule, now: Date): Where {
  const column = FILTERABLE_COLUMNS.get(rule.field);
  // Unreachable through the routes (the parser rejects it first); defensive here.
  if (!column) throw new CasesQueryError(`No se puede filtrar por "${rule.field}"`);
  switch (column.type) {
    case 'text':
      return textWhere(column.field, rule);
    case 'status':
      return statusWhere(column.field, rule);
    case 'date':
      return dateWhere(column.field, rule, now);
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Case ids of the operational filters
// ---------------------------------------------------------------------------

/**
 * Cases with open work past its due date, an open incident or an open request
 * that blocks the delivery — the same three facts `caseRisk` calls "en riesgo",
 * so the chip and the badge of a row never disagree.
 */
async function riskyCaseIds(now: Date): Promise<string[]> {
  const [overdue, incidents, blocking] = await Promise.all([
    prisma.workItem.findMany({
      where: {
        caseId: { not: null },
        status: { in: [...WORK_ITEM_OPEN_STATUSES] },
        dueAt: { lt: now },
      },
      select: { caseId: true },
      distinct: ['caseId'],
      take: SCAN_LIMIT,
    }),
    prisma.incident.findMany({
      where: { caseId: { not: null }, status: { in: [...INCIDENT_OPEN_STATUSES] } },
      select: { caseId: true },
      distinct: ['caseId'],
      take: SCAN_LIMIT,
    }),
    prisma.areaRequest.findMany({
      where: { blocksDelivery: true, status: { in: [...AREA_REQUEST_OPEN_STATUSES] } },
      select: { caseId: true },
      distinct: ['caseId'],
      take: SCAN_LIMIT,
    }),
  ]);
  const ids = new Set<string>();
  for (const row of [...overdue, ...incidents, ...blocking]) if (row.caseId) ids.add(row.caseId);
  return [...ids];
}

/** Cases with open work in this area or an open request addressed to it. */
async function caseIdsBlockedBy(areaKey: string): Promise<string[]> {
  const [items, requests] = await Promise.all([
    prisma.workItem.findMany({
      where: { caseId: { not: null }, areaKey, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
      select: { caseId: true },
      distinct: ['caseId'],
      take: SCAN_LIMIT,
    }),
    prisma.areaRequest.findMany({
      where: { toAreaKey: areaKey, status: { in: [...AREA_REQUEST_OPEN_STATUSES] } },
      select: { caseId: true },
      distinct: ['caseId'],
      take: SCAN_LIMIT,
    }),
  ]);
  const ids = new Set<string>();
  for (const row of [...items, ...requests]) if (row.caseId) ids.add(row.caseId);
  return [...ids];
}

/** Areas holding up at least one open case right now (chips of the toolbar). */
export async function blockingAreaKeys(): Promise<string[]> {
  const [items, requests] = await Promise.all([
    prisma.workItem.groupBy({
      by: ['areaKey'],
      where: { caseId: { not: null }, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
      _count: { _all: true },
    }),
    prisma.areaRequest.groupBy({
      by: ['toAreaKey'],
      where: { status: { in: [...AREA_REQUEST_OPEN_STATUSES] } },
      _count: { _all: true },
    }),
  ]);
  const keys = new Set<string>();
  for (const row of items) if (isAreaKey(row.areaKey)) keys.add(row.areaKey);
  for (const row of requests) if (isAreaKey(row.toAreaKey)) keys.add(row.toAreaKey);
  return [...keys];
}

// ---------------------------------------------------------------------------
// Where + order
// ---------------------------------------------------------------------------

async function buildWhere(user: CurrentUser, query: CaseQueryState, now: Date): Promise<Where> {
  const and: Where[] = [];
  // Without operations.view a person only sees the cases they own (core rule).
  if (!hasPermission(user, VIEW_PERMISSION)) and.push({ ownerUserId: user.id });
  if (query.scope === 'open') and.push({ status: { in: [...CASE_OPEN_STATUSES] } });
  if (query.scope === 'closed') and.push({ status: { in: ['closed', 'cancelled'] } });
  if (query.phase) and.push({ phase: query.phase });
  if (query.ownerUserId) and.push({ ownerUserId: query.ownerUserId });

  if (query.search) {
    const term = query.search.trim();
    if (term) {
      and.push({
        OR: [
          { caseNumber: { contains: term, mode: 'insensitive' } },
          { salesOrderNumber: { contains: term, mode: 'insensitive' } },
          { customerName: { contains: term, mode: 'insensitive' } },
        ],
      });
    }
  }

  if (query.areaKey) {
    const ids = await caseIdsBlockedBy(query.areaKey);
    and.push(ids.length > 0 ? { id: { in: ids } } : { id: { in: [] } });
  }

  if (query.risk === 'late') {
    and.push({ status: { in: [...CASE_OPEN_STATUSES] } }, { promisedAt: { lt: now } });
  } else if (query.risk === 'watch') {
    const soon = new Date(now.getTime() + 48 * 60 * 60_000);
    and.push({ status: { in: [...CASE_OPEN_STATUSES] } }, { promisedAt: { gte: now, lte: soon } });
  } else if (query.risk === 'risk') {
    const ids = await riskyCaseIds(now);
    and.push(
      { status: { in: [...CASE_OPEN_STATUSES] } },
      { OR: [{ promisedAt: null }, { promisedAt: { gte: now } }] },
      { OR: [{ status: 'blocked' }, ...(ids.length > 0 ? [{ id: { in: ids } }] : [])] }
    );
  }

  const rules = query.filters.rules
    .map((rule) => ruleWhere(rule, now))
    .filter((where) => Object.keys(where).length > 0);
  if (rules.length > 0) {
    if (query.filters.logic === 'OR') and.push({ OR: rules });
    else and.push(...rules);
  }

  return and.length > 0 ? { AND: and } : {};
}

function buildOrderBy(query: CaseQueryState): Prisma.OperationalCaseOrderByWithRelationInput[] {
  const order: Prisma.OperationalCaseOrderByWithRelationInput[] = [];
  for (const sort of query.sort) {
    // Defensive: the parser already rejected anything outside the registry.
    if (!SORTABLE_FIELDS.has(sort.field)) continue;
    order.push({ [sort.field]: sort.direction } as Prisma.OperationalCaseOrderByWithRelationInput);
  }
  if (order.length === 0) order.push({ lastActivityAt: 'desc' });
  order.push({ id: 'desc' });
  return order;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type CaseRecord = Awaited<ReturnType<typeof prisma.operationalCase.findMany>>[number];

async function decorate(user: CurrentUser, rows: CaseRecord[], now: Date): Promise<CaseRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const ownerIds = [...new Set(rows.map((row) => row.ownerUserId))];
  const orderIds = [
    ...new Set(rows.map((row) => row.zohoSalesOrderId).filter((id): id is string => Boolean(id))),
  ];
  const canSeeOrders = hasPermission(user, 'sales_orders.view');

  const [openItems, overdueItems, openRequests, openIncidents, owners, orders] = await Promise.all([
    prisma.workItem.groupBy({
      by: ['caseId', 'areaKey'],
      where: { caseId: { in: ids }, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
      _count: { _all: true },
    }),
    prisma.workItem.groupBy({
      by: ['caseId'],
      where: {
        caseId: { in: ids },
        status: { in: [...WORK_ITEM_OPEN_STATUSES] },
        dueAt: { lt: now },
      },
      _count: { _all: true },
    }),
    prisma.areaRequest.groupBy({
      by: ['caseId', 'toAreaKey', 'blocksDelivery'],
      where: { caseId: { in: ids }, status: { in: [...AREA_REQUEST_OPEN_STATUSES] } },
      _count: { _all: true },
    }),
    prisma.incident.groupBy({
      by: ['caseId'],
      where: { caseId: { in: ids }, status: { in: [...INCIDENT_OPEN_STATUSES] } },
      _count: { _all: true },
    }),
    prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } }),
    canSeeOrders && orderIds.length > 0
      ? prisma.salesOrder.findMany({
          where: { zohoSalesOrderId: { in: orderIds } },
          select: { id: true, zohoSalesOrderId: true },
        })
      : Promise.resolve([]),
  ]);

  const openByCase = new Map<string, number>();
  const areasByCase = new Map<string, Set<string>>();
  const addArea = (caseId: string | null, areaKey: string) => {
    if (!caseId || !isAreaKey(areaKey)) return;
    const set = areasByCase.get(caseId) ?? new Set<string>();
    set.add(areaKey);
    areasByCase.set(caseId, set);
  };
  for (const row of openItems) {
    if (!row.caseId) continue;
    openByCase.set(row.caseId, (openByCase.get(row.caseId) ?? 0) + row._count._all);
    addArea(row.caseId, row.areaKey);
  }
  const requestsByCase = new Map<string, number>();
  const blockingByCase = new Map<string, number>();
  for (const row of openRequests) {
    if (!row.caseId) continue;
    requestsByCase.set(row.caseId, (requestsByCase.get(row.caseId) ?? 0) + row._count._all);
    if (row.blocksDelivery) {
      blockingByCase.set(row.caseId, (blockingByCase.get(row.caseId) ?? 0) + row._count._all);
    }
    addArea(row.caseId, row.toAreaKey);
  }
  const overdueByCase = new Map(
    overdueItems.filter((row) => row.caseId).map((row) => [row.caseId as string, row._count._all])
  );
  const incidentsByCase = new Map(
    openIncidents.filter((row) => row.caseId).map((row) => [row.caseId as string, row._count._all])
  );
  const ownerNames = new Map(owners.map((owner) => [owner.id, owner.name]));
  const orderIdByZoho = new Map(orders.map((order) => [order.zohoSalesOrderId, order.id]));

  return rows.map((row): CaseRow => {
    const overdueWorkItems = overdueByCase.get(row.id) ?? 0;
    const openIncidentCount = incidentsByCase.get(row.id) ?? 0;
    const areaKeys = [...(areasByCase.get(row.id) ?? [])].sort();
    const risk: CaseRiskLevel = caseRisk(
      {
        status: row.status,
        promisedAt: row.promisedAt?.toISOString() ?? null,
        overdueWorkItems,
        openIncidents: openIncidentCount,
        blockingRequests: blockingByCase.get(row.id) ?? 0,
      },
      now
    );
    return {
      id: row.id,
      caseNumber: row.caseNumber,
      customerName: row.customerName,
      salesOrderNumber: row.salesOrderNumber,
      zohoSalesOrderId: row.zohoSalesOrderId,
      salesOrderId: row.zohoSalesOrderId ? (orderIdByZoho.get(row.zohoSalesOrderId) ?? null) : null,
      phase: row.phase,
      phaseLabel: (CASE_PHASE_LABELS as Record<string, string>)[row.phase] ?? row.phase,
      status: row.status,
      statusLabel: (CASE_STATUS_LABELS as Record<string, string>)[row.status] ?? row.status,
      priority: row.priority,
      priorityLabel: (PRIORITY_LABELS as Record<string, string>)[row.priority] ?? row.priority,
      ownerUserId: row.ownerUserId,
      ownerName: ownerNames.get(row.ownerUserId) ?? null,
      locationName: row.locationName,
      promisedAt: row.promisedAt?.toISOString() ?? null,
      openedAt: row.openedAt.toISOString(),
      lastActivityAt: row.lastActivityAt.toISOString(),
      openWorkItems: openByCase.get(row.id) ?? 0,
      overdueWorkItems,
      openRequests: requestsByCase.get(row.id) ?? 0,
      openIncidents: openIncidentCount,
      blockingAreas: areaKeys,
      blockingAreaLabels: areaKeys.map((key) => (isAreaKey(key) ? AREA_LABELS[key] : key)),
      risk,
      riskLabel: CASE_RISK_LABELS[risk],
      open: isOpenCaseStatus(row.status),
      version: row.version,
    };
  });
}

/** One page of the case list for `EntityWorkspace`. */
export async function listCaseRows(
  user: CurrentUser,
  query: CaseQueryState,
  options: { now?: Date } = {}
): Promise<EntityListResult<CaseRow>> {
  const now = options.now ?? new Date();
  const where = await buildWhere(user, query, now);
  const [total, rows] = await Promise.all([
    prisma.operationalCase.count({ where }),
    prisma.operationalCase.findMany({
      where,
      orderBy: buildOrderBy(query),
      skip: (query.page - 1) * query.page_size,
      take: query.page_size,
    }),
  ]);
  return {
    data: await decorate(user, rows, now),
    pagination: {
      page: query.page,
      page_size: query.page_size,
      total,
      total_pages: Math.max(1, Math.ceil(total / query.page_size)),
    },
  };
}

/** Rows of an export: the current page, the ticked rows or everything the filter matches. */
export async function exportCaseRows(
  user: CurrentUser,
  query: CaseQueryState,
  scope: { scope: 'current_page' | 'selected' | 'filtered'; selectedIds?: string[] },
  options: { now?: Date } = {}
): Promise<CaseRow[]> {
  const now = options.now ?? new Date();
  if (scope.scope === 'selected') {
    const ids = (scope.selectedIds ?? []).slice(0, EXPORT_LIMIT);
    if (ids.length === 0) return [];
    const base = await buildWhere(user, { ...query, page: 1 }, now);
    const rows = await prisma.operationalCase.findMany({
      where: { AND: [base, { id: { in: ids } }] },
      orderBy: buildOrderBy(query),
      take: EXPORT_LIMIT,
    });
    return decorate(user, rows, now);
  }
  const where = await buildWhere(user, query, now);
  const onlyPage = scope.scope === 'current_page';
  const rows = await prisma.operationalCase.findMany({
    where,
    orderBy: buildOrderBy(query),
    skip: onlyPage ? (query.page - 1) * query.page_size : 0,
    take: onlyPage ? query.page_size : EXPORT_LIMIT,
  });
  return decorate(user, rows, now);
}
