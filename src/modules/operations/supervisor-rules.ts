import type { OperationsSettings } from './operations-config';
import { AREA_REQUEST_OPEN_STATUSES, CASE_OPEN_STATUSES, type OperationsActor } from './types';
import { escalationLevelFor, nextEscalationLevel } from './work-items-service';

/**
 * Pure rules of the deterministic supervisor (plan section 2.6): what counts
 * as a finding, which escalation level applies, when an external sync is
 * stale, when a reservation deserves an alert, when a case can be closed
 * financially, who replaces an absent owner, and the idempotent command ids
 * `sup:{kind}:{objectId}:{bucket}` that make every tick safe to repeat.
 *
 * No I/O: `supervisor.ts` feeds these functions with bounded queries.
 */

export const SUPERVISOR_ACTOR_ID = 'ops.supervisor';
export const SUPERVISOR_ACTOR: OperationsActor = { type: 'system', id: SUPERVISOR_ACTOR_ID };

/** Every query of a tick is bounded to this many rows (`take 200`). */
export const SUPERVISOR_BATCH_SIZE = 200;
/** Cadence of the recurring `ops.supervisor` job. */
export const SUPERVISOR_EVERY_MS = 4 * 60_000;
/** A case touched less than this long ago is never reported as orphan (in-flight work). */
export const ORPHAN_GRACE_MINUTES = 1;
/** Minutes without progress after which a stale external sync becomes an incident. */
export const SYNC_INCIDENT_MINUTES = 60;
/** Blueprint steps the supervisor looks at. */
export const PREPARE_ORDER_STEP_KEY = 'preparar_pedido';
export const FINANCIAL_CLOSE_STEP_KEY = 'cierre_financiero';
/** Object type of the "reservation without preparation" work item (one open per case). */
export const RESERVATION_ALERT_OBJECT_TYPE = 'stock_reservation_alert';

/** Event types owned by the supervisor (module-specific, outside OPS_EVENTS). */
export const SUPERVISOR_EVENTS = {
  syncRequeued: 'supervisor.sync_requeued',
  reservationAlert: 'supervisor.reservation_alert',
} as const;

export const SUPERVISOR_COMMANDS = {
  orphanCase: 'supervisor.orphan_case',
  staleSync: 'supervisor.sync_stale',
  requestOverdue: 'supervisor.request_overdue',
  staleReservations: 'supervisor.stale_reservations',
  workItemOwnerAbsent: 'supervisor.owner_absent',
  caseOwnerAbsent: 'supervisor.case_owner_absent',
  financialClose: 'supervisor.financial_close',
  approvalExpired: 'supervisor.approval_expired',
} as const;

export type SupervisorFindingKind =
  | 'orphan'
  | 'overdue'
  | 'sync_stale'
  | 'sync_failure'
  | 'request_overdue'
  | 'stale_reservation'
  | 'owner_absent'
  | 'case_owner_absent'
  | 'financial_close'
  | 'approval_expired';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const COMMAND_ID_MAX = 160;
const UNSAFE_ID_CHARS = /[^A-Za-z0-9:_.\-]/g;

function includes(list: readonly string[], value: string | null | undefined): boolean {
  return typeof value === 'string' && list.includes(value);
}

/** Whole minutes from `from` to `to` (negative when `from` is later). */
export function minutesBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MINUTE_MS);
}

/** 32-bit FNV-1a, hex: a short deterministic suffix for ids that would be too long. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * `sup:{kind}:{objectId}:{bucket}`. The same finding in the same bucket always
 * yields the same id, so a repeated tick replays the stored result instead of
 * acting twice. Characters outside the ledger's id alphabet become `_` and an
 * id longer than the ledger allows is shortened with a stable hash.
 */
export function supervisorCommandId(
  kind: SupervisorFindingKind,
  objectId: string,
  bucket: string | number
): string {
  const raw = `sup:${kind}:${objectId}:${bucket}`;
  const safe = raw.replace(UNSAFE_ID_CHARS, '_');
  if (safe.length <= COMMAND_ID_MAX) return safe;
  const suffix = `-h${fnv1a(raw)}`;
  return `${safe.slice(0, COMMAND_ID_MAX - suffix.length)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Rule 1 — orphan cases
// ---------------------------------------------------------------------------

export interface OrphanCaseInput {
  status: string;
  /** Work items of the case in open | in_progress | waiting | escalated. */
  openWorkItems: number;
  /** Case steps in active | waiting (explicit waits such as external syncs). */
  activeSteps: number;
  lastActivityAt: Date;
}

/** An open case with nothing to do and nothing to wait for, untouched for the grace period. */
export function isOrphanCase(
  input: OrphanCaseInput,
  now: Date,
  graceMinutes: number = ORPHAN_GRACE_MINUTES
): boolean {
  if (!includes(CASE_OPEN_STATUSES, input.status)) return false;
  if (input.openWorkItems > 0 || input.activeSteps > 0) return false;
  return now.getTime() - input.lastActivityAt.getTime() >= graceMinutes * MINUTE_MS;
}

/**
 * Changes whenever the case or any of its work items changes: a case that
 * stays orphan after its follow-up work item is closed is reported again,
 * while an untouched orphan is reported once.
 */
export function orphanBucket(input: {
  version: number;
  lastActivityAt: Date;
  lastWorkItemAt: Date | null;
}): string {
  return `v${input.version}-${input.lastActivityAt.getTime()}-${input.lastWorkItemAt?.getTime() ?? 0}`;
}

// ---------------------------------------------------------------------------
// Rule 2 — overdue work items
// ---------------------------------------------------------------------------

export interface OverdueWorkItemInput {
  status: string;
  dueAt: Date;
  escalationLevel: number;
  escalatedAt: Date | null;
  waitUntil: Date | null;
}

/** A work item waiting for a future date is not late yet, whatever its due date says. */
export function isWaitingForFutureDate(item: OverdueWorkItemInput, now: Date): boolean {
  return item.status === 'waiting' && item.waitUntil !== null && item.waitUntil > now;
}

/**
 * Level the supervisor applies now: the ladder level that corresponds to the
 * lateness when it is higher than the level already applied; null when the
 * item is closed, not late, waiting for a future date or already escalated.
 */
export function overdueEscalationLevel(
  item: OverdueWorkItemInput,
  escalation: OperationsSettings['escalation'],
  now: Date
): number | null {
  if (isWaitingForFutureDate(item, now)) return null;
  return nextEscalationLevel(item, escalation, now);
}

// ---------------------------------------------------------------------------
// Rule 3 — stale external syncs (delivery orders mirrored in Zoho)
// ---------------------------------------------------------------------------

/** Sync states in which UNIK still owes or awaits something from Zoho. */
export const WATCHED_SYNC_STATES = ['pending_write', 'delivered_pending_write', 'written'] as const;

export interface SyncStalenessInput {
  zohoSyncState: string;
  zohoLastAttemptAt: Date | null;
  updatedAt: Date;
  version: number;
}

export interface SyncStaleness {
  watched: boolean;
  /** Minutes since the last progress (last attempt or last change of the row). */
  idleMinutes: number;
  requeueDue: boolean;
  /** Changes once per stale window, so a stuck write is re-enqueued at most once per window. */
  requeueBucket: string | null;
  incidentDue: boolean;
  incidentBucket: string | null;
}

export function evaluateSyncStaleness(
  order: SyncStalenessInput,
  now: Date,
  staleMinutes: number,
  incidentMinutes: number = SYNC_INCIDENT_MINUTES
): SyncStaleness {
  const watched = includes(WATCHED_SYNC_STATES, order.zohoSyncState);
  const lastProgress =
    order.zohoLastAttemptAt && order.zohoLastAttemptAt > order.updatedAt
      ? order.zohoLastAttemptAt
      : order.updatedAt;
  const idleMinutes = Math.max(0, minutesBetween(lastProgress, now));
  const window = Math.max(1, staleMinutes);
  const incidentAfter = Math.max(incidentMinutes, window);
  const requeueDue = watched && idleMinutes >= window;
  const incidentDue = watched && idleMinutes >= incidentAfter;
  return {
    watched,
    idleMinutes,
    requeueDue,
    requeueBucket: requeueDue
      ? `v${order.version}-${order.zohoSyncState}-w${Math.floor(idleMinutes / window)}`
      : null,
    incidentDue,
    incidentBucket: incidentDue ? `v${order.version}-${order.zohoSyncState}` : null,
  };
}

// ---------------------------------------------------------------------------
// Rule 4 — overdue area requests
// ---------------------------------------------------------------------------

/** Escalation level that matches how late an open request is (null when on time or closed). */
export function requestOverdueLevel(
  request: { status: string; dueAt: Date },
  escalation: OperationsSettings['escalation'],
  now: Date
): number | null {
  if (!includes(AREA_REQUEST_OPEN_STATUSES, request.status)) return null;
  const late = (now.getTime() - request.dueAt.getTime()) / MINUTE_MS;
  return escalationLevelFor(late, escalation);
}

// ---------------------------------------------------------------------------
// Rule 5 — old reservations without preparation
// ---------------------------------------------------------------------------

export function reservationAgeDays(createdAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS));
}

export function isReservationAlertDue(createdAt: Date, now: Date, alertDays: number): boolean {
  return reservationAgeDays(createdAt, now) >= Math.max(1, alertDays);
}

/** One alert per `alertDays` period of the oldest reservation of the case. */
export function reservationAlertBucket(
  oldestCreatedAt: Date,
  now: Date,
  alertDays: number
): string {
  const period = Math.max(1, alertDays);
  return `p${Math.floor(reservationAgeDays(oldestCreatedAt, now) / period)}`;
}

// ---------------------------------------------------------------------------
// Rule 6 — absent owners
// ---------------------------------------------------------------------------

export interface ReplacementOwnerInput {
  ownerUserId: string;
  backupUserId: string | null;
  backupActive: boolean;
  /** Area assignee (Responsible → lead → Administración → super admin), when resolvable. */
  assignee: { ownerUserId: string; backupUserId: string | null } | null;
  assigneeOwnerActive: boolean;
  assigneeBackupActive: boolean;
}

/**
 * Who takes the work of an inactive owner: the active backup first (keeping
 * the area assignee as the new backup), then the area assignee. Null when
 * nobody different from the absent owner is available.
 */
export function chooseReplacementOwner(
  input: ReplacementOwnerInput
): { ownerUserId: string; backupUserId: string | null } | null {
  const absent = input.ownerUserId;
  const assigneeOwner =
    input.assignee && input.assigneeOwnerActive && input.assignee.ownerUserId !== absent
      ? input.assignee.ownerUserId
      : null;
  const assigneeBackup =
    input.assignee?.backupUserId && input.assigneeBackupActive ? input.assignee.backupUserId : null;

  if (input.backupUserId && input.backupActive && input.backupUserId !== absent) {
    const next = assigneeOwner && assigneeOwner !== input.backupUserId ? assigneeOwner : null;
    return { ownerUserId: input.backupUserId, backupUserId: next };
  }
  if (assigneeOwner) {
    const backup =
      assigneeBackup && assigneeBackup !== assigneeOwner && assigneeBackup !== absent
        ? assigneeBackup
        : null;
    return { ownerUserId: assigneeOwner, backupUserId: backup };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 7 — automatic financial close
// ---------------------------------------------------------------------------

export interface SalesOrderSettlementInput {
  status: string | null;
  invoicedStatus: string | null;
  paidStatus: string | null;
}

const norm = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();

/** The synchronized Zoho sales order is fully invoiced and fully paid (and not void). */
export function isSalesOrderSettled(order: SalesOrderSettlementInput): boolean {
  if (norm(order.status) === 'void') return false;
  return norm(order.invoicedStatus) === 'invoiced' && norm(order.paidStatus) === 'paid';
}

export interface FinancialCloseInput {
  caseStatus: string;
  /** Status of the `cierre_financiero` step, or null when the case has no such step. */
  financialStepStatus: string | null;
  /** Open work items of the case that do not belong to the financial close step. */
  otherOpenWorkItems: number;
  salesOrder: SalesOrderSettlementInput | null;
}

/**
 * The case is waiting only for money: its financial close step is ready,
 * active or waiting (or, without blueprint steps, the case is ready to close),
 * nothing else is pending and the sales order is invoiced and paid.
 */
export function isFinancialCloseDue(input: FinancialCloseInput): boolean {
  if (!includes(CASE_OPEN_STATUSES, input.caseStatus)) return false;
  if (!input.salesOrder || !isSalesOrderSettled(input.salesOrder)) return false;
  if (input.otherOpenWorkItems > 0) return false;
  if (input.financialStepStatus === null) return input.caseStatus === 'ready_to_close';
  return ['ready', 'active', 'waiting'].includes(input.financialStepStatus);
}

// ---------------------------------------------------------------------------
// Rule 8 — expired business approvals
// ---------------------------------------------------------------------------

export interface ApprovalExpiryInput {
  status: string;
  expiresAt: Date | null;
}

/** A pending approval whose deadline already passed (without a deadline it never expires). */
export function isApprovalExpiryDue(input: ApprovalExpiryInput, now: Date): boolean {
  return (
    input.status === 'pending' &&
    input.expiresAt !== null &&
    input.expiresAt.getTime() <= now.getTime()
  );
}

// ---------------------------------------------------------------------------
// Counters (rule 9)
// ---------------------------------------------------------------------------

export const SUPERVISOR_RULE_KEYS = [
  'orphanCases',
  'overdueWorkItems',
  'staleSyncs',
  'overdueRequests',
  'staleReservations',
  'legacyClaims',
  'absentOwners',
  'financialClose',
  'expiredApprovals',
] as const;
export type SupervisorRuleKey = (typeof SUPERVISOR_RULE_KEYS)[number];

export interface SupervisorRuleCounters {
  /** Candidates returned by the bounded query. */
  checked: number;
  /** Commands that changed something (escalated, re-enqueued, reassigned, closed…). */
  actions: number;
  /** Incidents opened or reopened. */
  incidents: number;
  /** Candidates that needed nothing after re-checking (or replays of a previous tick). */
  skipped: number;
  /** Commands rejected by the engine. */
  rejected: number;
  /** Unexpected failures (the rule continues with the next candidate). */
  errors: number;
}

export type SupervisorCounters = Record<SupervisorRuleKey, SupervisorRuleCounters>;

export function emptyRuleCounters(): SupervisorRuleCounters {
  return { checked: 0, actions: 0, incidents: 0, skipped: 0, rejected: 0, errors: 0 };
}

export function emptySupervisorCounters(): SupervisorCounters {
  return Object.fromEntries(
    SUPERVISOR_RULE_KEYS.map((key) => [key, emptyRuleCounters()])
  ) as SupervisorCounters;
}

export function summarizeSupervisorCounters(counters: SupervisorCounters): {
  checked: number;
  actions: number;
  incidents: number;
  rejected: number;
  errors: number;
} {
  const total = { checked: 0, actions: 0, incidents: 0, rejected: 0, errors: 0 };
  for (const key of SUPERVISOR_RULE_KEYS) {
    const c = counters[key];
    total.checked += c.checked;
    total.actions += c.actions;
    total.incidents += c.incidents;
    total.rejected += c.rejected;
    total.errors += c.errors;
  }
  return total;
}
