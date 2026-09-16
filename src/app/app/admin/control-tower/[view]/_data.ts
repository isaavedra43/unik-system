import 'server-only';
import { prisma } from '@/lib/prisma';
import type { ApprovalWorkItemView } from '@/components/control-tower/ApprovalsPanel';
import type { ExceptionAssignee } from '@/components/control-tower/ExceptionActionDialog';
import type { AuditRow } from '@/components/control-tower/AuditPanel';
import type { AuditFilterState } from '@/components/control-tower/audit-model';
import { AUDIT_TARGET_TYPES } from '@/components/control-tower/audit-model';
import {
  CT_EXCEPTIONS_TABLE_KEY,
  CT_EXCEPTION_COLUMNS,
  CT_EXCEPTION_DEFAULT_COLUMN_ORDER,
  CT_EXCEPTION_DEFAULT_PAGE_SIZE,
} from '@/components/control-tower/exceptions-columns';
import {
  CtExceptionQueryError,
  exceptionQueryFromSearchParams,
  parseCtExceptionQuery,
  queryFromChips,
  toExceptionServiceQuery,
  type CtExceptionChipState,
  type CtExceptionQueryState,
} from '@/components/control-tower/exceptions-model';
import type { ApprovalPolicyRow } from '@/components/control-tower/policy-model';
import {
  relationsRebuildTotals,
  type RelationsRebuildStatus,
} from '@/components/control-tower/relations-rebuild-model';
import type { SourcingOption } from '@/components/control-tower/SourcingConfigPanel';
import type { MyWorkApproval, MyWorkProposal } from '@/components/operations/mywork-model';
import type { CurrentUser } from '@/modules/auth/authorization';
import {
  DASHBOARD_SCOPE_CONTROL_TOWER,
  readDashboardSnapshot,
} from '@/modules/areas/dashboard-service';
import {
  CONTROL_TOWER_SCOPE_KEY,
  getControlTowerOverview,
  type ControlTowerOverview,
} from '@/modules/control-tower/control-tower-service';
import {
  listControlTowerExceptions,
  type ExceptionsPage,
} from '@/modules/control-tower/exceptions-service';
import { listPeopleNow, type PeopleNowResult } from '@/modules/control-tower/people-service';
import { listPendingProposals, toProposalDTO } from '@/modules/extensions/proposals-service';
import { redactDeep } from '@/modules/extensions/secrets';
import {
  listPendingApprovals,
  type PendingApprovalDTO,
} from '@/modules/operations/approvals-service';
import { getOperationsConfig, type OperationsConfig } from '@/modules/operations/operations-config';
import { OPS_RELATIONS_REBUILD_JOB } from '@/modules/operations/operations-jobs';
import { listRelationSources } from '@/modules/operations/relations-rebuild';
import { getSourcingConfig, type SourcingConfig } from '@/modules/purchases/sourcing-config';
import { AREA_LABELS, isAreaKey } from '@/modules/operations/types';
import { getUserTablePreference } from '@/modules/sales/table-preferences-service';
import { getDefaultTableView, listTableViews } from '@/modules/sales/table-views-service';
import { getUnreadNotificationCount } from '@/modules/sales/notifications-service';
import type { TablePreferenceConfig } from '@/modules/shared/entity-workspace-types';

/**
 * Server readers of the Control Tower views (plan 7.7). SERVER ONLY.
 *
 * Every function re-checks the permission through the service it calls
 * (`assertControlTowerAccess`), on top of the page gate: a reader added here
 * without the gate still returns nothing.
 *
 * A secondary block that fails becomes a Spanish notice instead of breaking the
 * whole view (`settle`), so one broken projection never hides the operation.
 */

/** A snapshot older than this is not worth showing when opening the screen. */
const SNAPSHOT_TTL_MS = 5 * 60_000;
const MAX_APPROVAL_WORK_ITEMS = 200;
const MAX_ASSIGNEES = 200;
const AUDIT_PAGE_SIZE = 50;

export async function settle<T>(
  promise: Promise<T>,
  label: string
): Promise<{ value: T | null; warning: string | null }> {
  try {
    return { value: await promise, warning: null };
  } catch (error) {
    console.error(
      JSON.stringify({
        component: 'control-tower-page',
        event: 'load_failed',
        part: label,
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return {
      value: null,
      warning: `No pudimos cargar ${label}. Recarga la página para intentarlo de nuevo.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------

function looksLikeOverview(value: unknown): value is ControlTowerOverview {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<ControlTowerOverview>;
  return (
    typeof payload.computedAt === 'string' &&
    Array.isArray(payload.tiles) &&
    Array.isArray(payload.charts) &&
    Array.isArray(payload.alerts) &&
    Array.isArray(payload.areas)
  );
}

export interface OverviewView {
  overview: ControlTowerOverview | null;
  source: 'snapshot' | 'live';
  note: string | null;
  /** Last movement of an open case: the copilot's re-analysis anchor. */
  activityAt: string | null;
}

/**
 * The stored snapshot when it is fresh (the dashboards job writes it every five
 * minutes), otherwise the live computation. A snapshot with an old shape is
 * discarded instead of rendering half a screen.
 */
export async function loadOverviewView(
  user: CurrentUser,
  options: { now?: Date } = {}
): Promise<OverviewView> {
  const now = options.now ?? new Date();
  const [snapshot, activity] = await Promise.all([
    readDashboardSnapshot(DASHBOARD_SCOPE_CONTROL_TOWER, CONTROL_TOWER_SCOPE_KEY).catch(() => null),
    prisma.operationalCase
      .aggregate({
        where: { status: { in: ['open', 'waiting', 'blocked', 'ready_to_close'] } },
        _max: { lastActivityAt: true },
      })
      .catch(() => null),
  ]);
  const activityAt = activity?._max.lastActivityAt?.toISOString() ?? null;

  if (snapshot && looksLikeOverview(snapshot.payload)) {
    const age = now.getTime() - snapshot.computedAt.getTime();
    if (age < SNAPSHOT_TTL_MS) {
      return { overview: snapshot.payload, source: 'snapshot', note: null, activityAt };
    }
  }

  const live = await settle(getControlTowerOverview(user, { now }), 'el resumen de la operación');
  return {
    overview: live.value,
    source: 'live',
    note: live.warning,
    activityAt,
  };
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

export async function loadPeopleView(
  user: CurrentUser,
  options: { now?: Date } = {}
): Promise<{ people: PeopleNowResult; warning: string | null }> {
  const now = options.now ?? new Date();
  const loaded = await settle(listPeopleNow(user, { now, limit: 100 }), 'a las personas');
  return {
    people: loaded.value ?? {
      computedAt: now.toISOString(),
      people: [],
      totals: { people: 0, active: 0, withOverdue: 0, unassigned: 0 },
    },
    warning: loaded.warning,
  };
}

// ---------------------------------------------------------------------------
// Excepciones
// ---------------------------------------------------------------------------

export interface ExceptionsView {
  page: ExceptionsPage;
  query: CtExceptionQueryState;
  preference: TablePreferenceConfig;
  views: Awaited<ReturnType<typeof listTableViews>>;
  defaultViewId: string | null;
  unreadNotifications: number;
  assignees: ExceptionAssignee[];
  warning: string | null;
}

const defaultExceptionPreference: TablePreferenceConfig = {
  version: 1,
  columnOrder: CT_EXCEPTION_DEFAULT_COLUMN_ORDER,
  columnVisibility: Object.fromEntries(
    CT_EXCEPTION_COLUMNS.map((column) => [column.id, column.defaultVisible])
  ),
  columnWidths: Object.fromEntries(
    CT_EXCEPTION_COLUMNS.map((column) => [column.id, column.defaultWidth])
  ),
  columnPinning: { left: [], right: [] },
  density: 'normal',
  pageSize: CT_EXCEPTION_DEFAULT_PAGE_SIZE,
};

/** Active people who can receive a reassigned work item (never bots). */
export async function listExceptionAssignees(): Promise<ExceptionAssignee[]> {
  const [users, responsibles] = await Promise.all([
    prisma.user.findMany({
      where: { isActive: true, isBot: false },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: MAX_ASSIGNEES,
    }),
    prisma.responsible.findMany({
      where: { active: true },
      select: { area: true, userId: true, backupUserId: true },
    }),
  ]);
  const areaByUser = new Map<string, string>();
  for (const row of responsibles) {
    if (!isAreaKey(row.area)) continue;
    const label = AREA_LABELS[row.area];
    if (row.userId && !areaByUser.has(row.userId)) areaByUser.set(row.userId, label);
    if (row.backupUserId && !areaByUser.has(row.backupUserId)) {
      areaByUser.set(row.backupUserId, label);
    }
  }
  return users.map((row) => ({
    id: row.id,
    name: row.name,
    areaLabel: areaByUser.get(row.id) ?? null,
  }));
}

export async function loadExceptionsView(
  user: CurrentUser,
  chips: CtExceptionChipState,
  options: { now?: Date; searchParams?: Record<string, string | undefined> } = {}
): Promise<ExceptionsView> {
  const now = options.now ?? new Date();
  // A shared link carries the search, the page and the sort of the table; an
  // unusable one falls back to the chips with a notice instead of a 500.
  let query: CtExceptionQueryState;
  let queryWarning: string | null = null;
  try {
    query = exceptionQueryFromSearchParams(options.searchParams ?? {}, chips);
  } catch (error) {
    query = queryFromChips(chips);
    queryWarning =
      error instanceof CtExceptionQueryError
        ? `${error.message}. Se muestra la lista sin ese ajuste.`
        : 'No pudimos aplicar los filtros del enlace. Se muestra la lista completa.';
  }
  const [page, preference, views, defaultView, unread, assignees] = await Promise.all([
    settle(
      listControlTowerExceptions(user, toExceptionServiceQuery(query), { now }),
      'las excepciones'
    ),
    getUserTablePreference(user.id, CT_EXCEPTIONS_TABLE_KEY).catch(() => null),
    listTableViews(user.id, CT_EXCEPTIONS_TABLE_KEY).catch(() => ({
      privateViews: [],
      sharedViews: [],
    })),
    getDefaultTableView(user.id, CT_EXCEPTIONS_TABLE_KEY).catch(() => null),
    getUnreadNotificationCount(user.id).catch(() => 0),
    listExceptionAssignees().catch(() => [] as ExceptionAssignee[]),
  ]);

  return {
    page: page.value ?? {
      data: [],
      pagination: { page: 1, page_size: CT_EXCEPTION_DEFAULT_PAGE_SIZE, total: 0, total_pages: 1 },
      counts: [],
      computedAt: now.toISOString(),
    },
    query,
    preference: preference ?? defaultExceptionPreference,
    views,
    defaultViewId: defaultView?.id ?? null,
    unreadNotifications: unread,
    assignees,
    warning: page.warning ?? queryWarning,
  };
}

/** Same reader the table's own API route uses, so both answer identically. */
export async function listExceptionsPage(
  user: CurrentUser,
  rawQuery: unknown,
  options: { now?: Date } = {}
): Promise<ExceptionsPage> {
  const query = parseCtExceptionQuery(rawQuery);
  return listControlTowerExceptions(user, toExceptionServiceQuery(query), {
    now: options.now ?? new Date(),
  });
}

// ---------------------------------------------------------------------------
// Aprobaciones
// ---------------------------------------------------------------------------

async function toApprovalViews(rows: PendingApprovalDTO[]): Promise<MyWorkApproval[]> {
  if (rows.length === 0) return [];
  const userIds = [...new Set(rows.map((row) => row.requestedByUserId))];
  const caseIds = [
    ...new Set(rows.map((row) => row.caseId).filter((id): id is string => Boolean(id))),
  ];
  const [users, cases] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
    caseIds.length > 0
      ? prisma.operationalCase.findMany({
          where: { id: { in: caseIds } },
          select: { id: true, caseNumber: true },
        })
      : Promise.resolve([]),
  ]);
  const names = new Map(users.map((row) => [row.id, row.name]));
  const caseNumbers = new Map(cases.map((row) => [row.id, row.caseNumber]));
  return rows.map((row) => ({
    id: row.id,
    scopeLabel: row.scopeLabel,
    targetType: row.targetType,
    targetId: row.targetId,
    amount: row.amount,
    currency: row.currency,
    requiredApprovals: row.requiredApprovals,
    approvals: row.approvals,
    requestedByName: names.get(row.requestedByUserId) ?? null,
    caseId: row.caseId,
    caseNumber: row.caseId ? (caseNumbers.get(row.caseId) ?? null) : null,
    areaLabel: row.areaKey && isAreaKey(row.areaKey) ? AREA_LABELS[row.areaKey] : null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    version: row.version,
  }));
}

function toProposalViews(
  user: CurrentUser,
  rows: Parameters<typeof toProposalDTO>[0][]
): MyWorkProposal[] {
  return rows.map((row) => {
    const dto = toProposalDTO(row);
    return {
      id: dto.id,
      toolName: dto.toolName,
      summary: dto.summary,
      effect: dto.effect,
      expiresAt: dto.expiresAt,
      args: redactDeep(dto.args),
      recipient: dto.recipient,
      status: dto.status,
      error: dto.error,
      conversationId: dto.conversationId,
      createdAt: dto.createdAt,
      awaitingSecondApproval: dto.awaitingSecondApproval,
      signedByMe: dto.awaitingSecondApproval && dto.decisionBy === user.id,
    };
  });
}

async function listOpenApprovalWorkItems(now: Date): Promise<ApprovalWorkItemView[]> {
  const rows = await prisma.workItem.findMany({
    where: { kind: 'approval', status: { in: ['open', 'in_progress', 'waiting', 'escalated'] } },
    orderBy: [{ dueAt: 'asc' }],
    take: MAX_APPROVAL_WORK_ITEMS,
    select: {
      id: true,
      title: true,
      areaKey: true,
      status: true,
      ownerUserId: true,
      dueAt: true,
      caseId: true,
    },
  });
  const ownerIds = [...new Set(rows.map((row) => row.ownerUserId))];
  const caseIds = [
    ...new Set(rows.map((row) => row.caseId).filter((id): id is string => Boolean(id))),
  ];
  const [owners, cases] = await Promise.all([
    ownerIds.length > 0
      ? prisma.user.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, name: true, username: true },
        })
      : Promise.resolve([]),
    caseIds.length > 0
      ? prisma.operationalCase.findMany({
          where: { id: { in: caseIds } },
          select: { id: true, caseNumber: true },
        })
      : Promise.resolve([]),
  ]);
  const nameById = new Map(owners.map((row) => [row.id, row.name || row.username]));
  const caseNumbers = new Map(cases.map((row) => [row.id, row.caseNumber]));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    areaLabel: isAreaKey(row.areaKey) ? AREA_LABELS[row.areaKey] : row.areaKey,
    status: row.status,
    ownerName: nameById.get(row.ownerUserId) ?? null,
    dueAt: row.dueAt.toISOString(),
    overdue: row.dueAt.getTime() < now.getTime(),
    caseId: row.caseId,
    caseNumber: row.caseId ? (caseNumbers.get(row.caseId) ?? null) : null,
  }));
}

export interface ApprovalsView {
  approvals: MyWorkApproval[];
  proposals: MyWorkProposal[];
  workItems: ApprovalWorkItemView[];
  warnings: string[];
}

export async function loadApprovalsView(
  user: CurrentUser,
  options: { now?: Date } = {}
): Promise<ApprovalsView> {
  const now = options.now ?? new Date();
  const [approvals, proposals, workItems] = await Promise.all([
    settle(
      listPendingApprovals(user, { limit: 50, now }).then(toApprovalViews),
      'las aprobaciones de negocio'
    ),
    settle(
      listPendingProposals(user).then((rows) => toProposalViews(user, rows)),
      'las propuestas de la IA'
    ),
    settle(listOpenApprovalWorkItems(now), 'las aprobaciones abiertas de la empresa'),
  ]);
  return {
    approvals: approvals.value ?? [],
    proposals: proposals.value ?? [],
    workItems: workItems.value ?? [],
    warnings: [approvals.warning, proposals.warning, workItems.warning].filter(
      (warning): warning is string => Boolean(warning)
    ),
  };
}

// ---------------------------------------------------------------------------
// Auditoría
// ---------------------------------------------------------------------------

export interface AuditView {
  page: {
    data: AuditRow[];
    pagination: { page: number; page_size: number; total: number; total_pages: number };
  };
  actors: Array<{ id: string; name: string }>;
  warning: string | null;
}

async function loadAuditPage(filters: AuditFilterState): Promise<AuditView['page']> {
  const from = filters.from ? new Date(`${filters.from}T00:00:00.000Z`) : null;
  const to = filters.to ? new Date(`${filters.to}T23:59:59.999Z`) : null;
  const targetTypes = filters.targetType
    ? [filters.targetType].filter((value) =>
        (AUDIT_TARGET_TYPES as readonly string[]).includes(value)
      )
    : [...AUDIT_TARGET_TYPES];
  // Un tipo que no es de operaciones (URL a mano) devuelve NADA, nunca todo:
  // la misma regla que aplica la ruta, para que la primera carga y la página
  // siguiente digan lo mismo.
  const unknownTypeRequested = filters.targetType !== '' && targetTypes.length === 0;

  const where = {
    targetType: { in: unknownTypeRequested ? [] : targetTypes },
    ...(filters.action.trim()
      ? { action: { contains: filters.action.trim(), mode: 'insensitive' as const } }
      : {}),
    ...(filters.actorUserId.trim() ? { actorUserId: filters.actorUserId.trim() } : {}),
    ...(filters.targetId.trim() ? { targetId: filters.targetId.trim() } : {}),
    ...(from || to
      ? {
          createdAt: {
            ...(from && !Number.isNaN(from.getTime()) ? { gte: from } : {}),
            ...(to && !Number.isNaN(to.getTime()) ? { lt: to } : {}),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: AUDIT_PAGE_SIZE,
      select: {
        id: true,
        actorUserId: true,
        action: true,
        targetType: true,
        targetId: true,
        metadata: true,
        createdAt: true,
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  const actorIds = [...new Set(rows.map((row) => row.actorUserId).filter(Boolean))] as string[];
  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, username: true, isBot: true },
      })
    : [];
  const byId = new Map(actors.map((row) => [row.id, row]));

  return {
    data: rows.map((row) => {
      const actor = row.actorUserId ? byId.get(row.actorUserId) : null;
      return {
        id: row.id,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        metadata: row.metadata,
        createdAt: row.createdAt.toISOString(),
        actorUserId: row.actorUserId,
        actorName: actor ? actor.name || actor.username : null,
        actorIsBot: actor?.isBot ?? false,
      };
    }),
    pagination: {
      page: 1,
      page_size: AUDIT_PAGE_SIZE,
      total,
      total_pages: Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE)),
    },
  };
}

/** People who can act in operations, offered as the audit's actor filter. */
async function listAuditActors(): Promise<Array<{ id: string; name: string }>> {
  const rows = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, name: true, username: true },
    orderBy: { name: 'asc' },
    take: MAX_ASSIGNEES,
  });
  return rows.map((row) => ({ id: row.id, name: row.name || row.username }));
}

export async function loadAuditView(filters: AuditFilterState): Promise<AuditView> {
  const [page, actors] = await Promise.all([
    settle(loadAuditPage(filters), 'la auditoría'),
    settle(listAuditActors(), 'las personas de la auditoría'),
  ]);
  return {
    page: page.value ?? {
      data: [],
      pagination: { page: 1, page_size: AUDIT_PAGE_SIZE, total: 0, total_pages: 1 },
    },
    actors: actors.value ?? [],
    warning: page.warning,
  };
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

export function toPolicyRow(row: {
  id: string;
  scope: string;
  categoryId: string | null;
  minAmount: { toString(): string };
  maxAmount: { toString(): string } | null;
  currency: string;
  requiredApprovals: number;
  expiresAfterMinutes: number | null;
  approverRoleKeys: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): ApprovalPolicyRow {
  return {
    id: row.id,
    scope: row.scope as ApprovalPolicyRow['scope'],
    categoryId: row.categoryId,
    categoryLabel: null,
    minAmount: row.minAmount.toString(),
    maxAmount: row.maxAmount === null ? null : row.maxAmount.toString(),
    currency: row.currency,
    requiredApprovals: row.requiredApprovals,
    expiresAfterMinutes: row.expiresAfterMinutes,
    approverRoleKeys: row.approverRoleKeys,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listApprovalPolicies(): Promise<ApprovalPolicyRow[]> {
  const [rows, categories] = await Promise.all([
    prisma.approvalPolicy.findMany({ orderBy: [{ scope: 'asc' }, { minAmount: 'asc' }] }),
    prisma.financeCategory.findMany({
      where: { status: 'active' },
      select: { id: true, name: true },
    }),
  ]);
  const nameById = new Map(categories.map((row) => [row.id, row.name]));
  return rows.map((row) => {
    const policy = toPolicyRow(row);
    return {
      ...policy,
      categoryLabel: policy.categoryId ? (nameById.get(policy.categoryId) ?? null) : null,
    };
  });
}

export interface SettingsView {
  config: OperationsConfig;
  /** Configuración del Laboratorio de Sourcing (fila `IntegrationConfig` 'sourcing'). */
  sourcing: SourcingConfig;
  /** Cuentas de la bandeja por las que se le puede escribir a un proveedor. */
  sourcingAccounts: SourcingOption[];
  /** Conexiones de extensión activas que pueden guardar la llave de Brave Search. */
  sourcingConnections: SourcingOption[];
  policies: ApprovalPolicyRow[];
  roles: Array<{ key: string; name: string }>;
  categories: Array<{ id: string; name: string }>;
  areas: Array<{ key: string; label: string; leadUserId: string | null }>;
  activeUsers: Array<{ id: string; name: string }>;
  /** Fuentes de las que se puede reconstruir la proyección del grafo (plan 2.1). */
  relationSources: Array<{ key: string; label: string }>;
  /** Última reconstrucción encolada, para no pedir otra a ciegas. */
  lastRelationsRebuild: RelationsRebuildStatus | null;
  warnings: string[];
}

async function loadLastRelationsRebuild(): Promise<RelationsRebuildStatus | null> {
  const job = await prisma.backgroundJob.findFirst({
    where: { type: OPS_RELATIONS_REBUILD_JOB },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      progress: true,
      createdAt: true,
      completedAt: true,
      lastError: true,
      result: true,
    },
  });
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    createdAtIso: job.createdAt.toISOString(),
    completedAtIso: job.completedAt ? job.completedAt.toISOString() : null,
    lastError: job.lastError,
    totals: job.status === 'completed' ? relationsRebuildTotals(job.result) : null,
  };
}

export async function loadSettingsView(): Promise<SettingsView> {
  // Se lanza antes del Promise.all para que viaje en paralelo sin re-indentarlo.
  const rebuildPromise = settle(loadLastRelationsRebuild(), 'la última reconstrucción del grafo');
  const [config, sourcing, accounts, connections, policies, roles, categories, areas, activeUsers] =
    await Promise.all([
      getOperationsConfig(),
      getSourcingConfig(),
      settle(
        prisma.commAccount.findMany({
          where: { status: 'active' },
          select: { id: true, label: true, provider: true, identifier: true },
          orderBy: { label: 'asc' },
          take: 100,
        }),
        'las cuentas de la bandeja'
      ),
      settle(
        prisma.extensionConnection.findMany({
          where: { status: 'active' },
          select: { id: true, name: true, extensionId: true },
          orderBy: { name: 'asc' },
          take: 100,
        }),
        'las conexiones de extensiones'
      ),
      settle(listApprovalPolicies(), 'las políticas de aprobación'),
      settle(
        prisma.role.findMany({
          where: { isActive: true },
          select: { key: true, name: true },
          orderBy: { name: 'asc' },
          take: 100,
        }),
        'los roles'
      ),
      settle(
        prisma.financeCategory.findMany({
          where: { status: 'active' },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
          take: 300,
        }),
        'las categorías de gasto'
      ),
      settle(
        prisma.area.findMany({
          select: { key: true, label: true, leadUserId: true },
          orderBy: { sortOrder: 'asc' },
        }),
        'las áreas operativas'
      ),
      settle(
        prisma.user.findMany({
          where: { isActive: true, isBot: false },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
          take: 500,
        }),
        'los usuarios activos'
      ),
    ]);
  const lastRebuild = await rebuildPromise;
  return {
    config,
    sourcing,
    sourcingAccounts: (accounts.value ?? []).map((account) => ({
      id: account.id,
      label: `${account.label} · ${account.provider} · ${account.identifier}`,
    })),
    sourcingConnections: (connections.value ?? []).map((connection) => ({
      id: connection.id,
      label: `${connection.name} · ${connection.extensionId}`,
    })),
    policies: policies.value ?? [],
    roles: roles.value ?? [],
    categories: categories.value ?? [],
    areas: areas.value ?? [],
    activeUsers: activeUsers.value ?? [],
    relationSources: listRelationSources(),
    lastRelationsRebuild: lastRebuild.value ?? null,
    warnings: [
      accounts.warning,
      connections.warning,
      policies.warning,
      roles.warning,
      categories.warning,
      areas.warning,
      activeUsers.warning,
      lastRebuild.warning,
    ].filter((warning): warning is string => Boolean(warning)),
  };
}
