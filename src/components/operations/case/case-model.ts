import type { OfflineCommandInput } from '@/lib/offline-commands';
import { areaWorkspaceHref } from '@/components/operations/copilot-starters';
import {
  WORK_ITEM_ACTION_LABELS,
  WORK_ITEM_ACTION_SUCCESS,
  availableActions,
  buildWorkItemCommand,
  type WorkItemUiAction,
} from '@/components/operations/mywork-model';

/**
 * View model of the Expediente 360 (plan 2.7 / 7.4). PURE: no React, no
 * Prisma, no I/O, so the server loader and the client components share exactly
 * the same meaning and the rules are unit tested on their own.
 *
 * Nothing here decides what the engine allows: every action ends in
 * `executeCommand` through `POST /app/operations/api/commands`, which checks
 * permissions, the transition and the optimistic version again. Hiding a
 * button is a courtesy, never the control.
 *
 * Dates, command payloads and outcome messages are REUSED from "Mi trabajo"
 * (`mywork-model`); the case timeline is rendered on the server with
 * `formatTimelineLine` (agents/templates), never re-worded here.
 */

export const CASES_PATH = '/app/operations';
export const CASE_AGGREGATE_TYPE = 'operational_case';
export const WORK_ITEM_AGGREGATE_TYPE = 'work_item';

/** Realtime messages that bring news of a case (`case:{id}`). */
export const CASE_REALTIME_TYPES = ['ops.events', 'ops.requests'] as const;

export function caseHref(caseId: string): string {
  return `${CASES_PATH}/cases/${encodeURIComponent(caseId)}`;
}

export type CaseTone = 'default' | 'success' | 'danger' | 'warning' | 'info' | 'weak';

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

export type CaseRiskLevel = 'ok' | 'watch' | 'risk' | 'late';

export const CASE_RISK_LABELS: Readonly<Record<CaseRiskLevel, string>> = {
  ok: 'En tiempo',
  watch: 'Por vencer',
  risk: 'En riesgo',
  late: 'Vencido',
};

export const CASE_RISK_TONES: Readonly<Record<CaseRiskLevel, CaseTone>> = {
  ok: 'success',
  watch: 'warning',
  risk: 'warning',
  late: 'danger',
};

/** A promise this close counts as "por vencer" (48 h, plan 7.3: prometidos ≤48 h). */
export const CASE_RISK_SOON_MS = 48 * 60 * 60_000;

export const CASE_OPEN_STATUSES: readonly string[] = [
  'open',
  'waiting',
  'blocked',
  'ready_to_close',
];

export function isOpenCaseStatus(status: string): boolean {
  return CASE_OPEN_STATUSES.includes(status);
}

export interface CaseRiskInput {
  status: string;
  /** ISO instant of the promise, or null when the order has no date. */
  promisedAt: string | null;
  overdueWorkItems: number;
  openIncidents: number;
  /** Requests that block the delivery and are still open. */
  blockingRequests?: number;
}

/**
 * Risk of a case, in this order: a closed case has none; a passed promise is
 * `late`; anything blocked, overdue, with an open incident or a blocking
 * request is `risk`; a promise within 48 h is `watch`; otherwise `ok`.
 */
export function caseRisk(input: CaseRiskInput, now: Date): CaseRiskLevel {
  if (!isOpenCaseStatus(input.status)) return 'ok';
  const promised = input.promisedAt ? Date.parse(input.promisedAt) : Number.NaN;
  if (Number.isFinite(promised) && promised < now.getTime()) return 'late';
  if (
    input.status === 'blocked' ||
    input.overdueWorkItems > 0 ||
    input.openIncidents > 0 ||
    (input.blockingRequests ?? 0) > 0
  ) {
    return 'risk';
  }
  if (Number.isFinite(promised) && promised - now.getTime() <= CASE_RISK_SOON_MS) return 'watch';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Phases and step progress
// ---------------------------------------------------------------------------

export const CASE_PHASE_ORDER: readonly string[] = [
  'planning',
  'sourcing',
  'preparing',
  'delivering',
  'closing',
];

/** Step statuses that no longer need anybody. */
const CLOSED_STEP_STATUSES = new Set(['done', 'skipped', 'cancelled']);
const FAILED_STEP_STATUS = 'failed';
const ACTIVE_STEP_STATUSES = new Set(['ready', 'active', 'waiting']);

export interface CaseStepView {
  id: string;
  stepKey: string;
  label: string;
  areaKey: string;
  areaLabel: string;
  scopeKey: string;
  /** Name of the demand / allocation the step belongs to (empty for case scope). */
  scopeLabel: string | null;
  kind: string;
  kindLabel: string;
  status: string;
  statusLabel: string;
  phase: string;
  /** Position of the step in the blueprint (stable order of the process). */
  order: number;
  slaMinutes: number;
  dueAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  overdue: boolean;
}

export interface CasePhaseProgressItem {
  key: string;
  label: string;
  total: number;
  done: number;
  state: 'done' | 'current' | 'pending';
}

export interface CaseProgress {
  /** Blueprint steps with at least one instance in this case. */
  total: number;
  done: number;
  /** 0–100, rounded. */
  percent: number;
  overdue: number;
  phases: CasePhaseProgressItem[];
}

/**
 * Progress over the steps of the process: one unit per blueprint step that
 * exists in this case (a step repeated per demand counts once and is done only
 * when every instance closed), so "8 de 15 pasos" means the same in every case.
 */
export function caseProgress(
  steps: readonly CaseStepView[],
  phaseLabels: Readonly<Record<string, string>>,
  currentPhase: string
): CaseProgress {
  const byKey = new Map<
    string,
    { phase: string; order: number; done: boolean; overdue: boolean }
  >();
  for (const step of steps) {
    const closed = CLOSED_STEP_STATUSES.has(step.status);
    const entry = byKey.get(step.stepKey);
    if (!entry) {
      byKey.set(step.stepKey, {
        phase: step.phase,
        order: step.order,
        done: closed,
        overdue: step.overdue,
      });
      continue;
    }
    entry.done = entry.done && closed;
    entry.overdue = entry.overdue || step.overdue;
    entry.order = Math.min(entry.order, step.order);
  }

  const entries = [...byKey.values()];
  const total = entries.length;
  const done = entries.filter((entry) => entry.done).length;
  const currentIndex = CASE_PHASE_ORDER.indexOf(currentPhase);

  const phases = CASE_PHASE_ORDER.map((key, index): CasePhaseProgressItem => {
    const ofPhase = entries.filter((entry) => entry.phase === key);
    const phaseDone = ofPhase.filter((entry) => entry.done).length;
    const state: CasePhaseProgressItem['state'] =
      key === currentPhase
        ? 'current'
        : currentIndex >= 0 && index < currentIndex
          ? 'done'
          : ofPhase.length > 0 && ofPhase.length === phaseDone
            ? 'done'
            : 'pending';
    return {
      key,
      label: phaseLabels[key] ?? key,
      total: ofPhase.length,
      done: phaseDone,
      state,
    };
  }).filter((phase) => phase.total > 0 || phase.key === currentPhase);

  return {
    total,
    done,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    overdue: entries.filter((entry) => entry.overdue && !entry.done).length,
    phases,
  };
}

export interface CaseStepGroup {
  areaKey: string;
  areaLabel: string;
  steps: CaseStepView[];
  open: number;
  overdue: number;
}

/** Steps grouped by area, areas ordered by their earliest step in the process. */
export function groupStepsByArea(steps: readonly CaseStepView[]): CaseStepGroup[] {
  const groups = new Map<string, CaseStepGroup>();
  for (const step of steps) {
    const group = groups.get(step.areaKey) ?? {
      areaKey: step.areaKey,
      areaLabel: step.areaLabel,
      steps: [],
      open: 0,
      overdue: 0,
    };
    group.steps.push(step);
    if (ACTIVE_STEP_STATUSES.has(step.status)) group.open += 1;
    if (step.overdue && !CLOSED_STEP_STATUSES.has(step.status)) group.overdue += 1;
    groups.set(step.areaKey, group);
  }
  const ordered = [...groups.values()];
  for (const group of ordered) {
    group.steps.sort((a, b) => a.order - b.order || a.scopeKey.localeCompare(b.scopeKey));
  }
  return ordered.sort((a, b) => (a.steps[0]?.order ?? 999) - (b.steps[0]?.order ?? 999));
}

export function stepTone(step: Pick<CaseStepView, 'status' | 'overdue'>): CaseTone {
  if (step.status === FAILED_STEP_STATUS) return 'danger';
  if (step.status === 'done') return 'success';
  if (step.status === 'skipped' || step.status === 'cancelled') return 'weak';
  if (step.overdue) return 'danger';
  if (step.status === 'waiting') return 'warning';
  if (step.status === 'active') return 'info';
  return 'default';
}

// ---------------------------------------------------------------------------
// Work items of the case
// ---------------------------------------------------------------------------

export interface CaseWorkItemView {
  id: string;
  title: string;
  areaKey: string;
  areaLabel: string;
  kind: string;
  kindLabel: string;
  status: string;
  statusLabel: string;
  ownerUserId: string;
  ownerName: string | null;
  backupUserId: string | null;
  backupName: string | null;
  dueAt: string;
  overdue: boolean;
  escalationLevel: number;
  waitReason: string | null;
  stepId: string | null;
  objectType: string | null;
  objectId: string | null;
  requiredEvidence: string[];
  /** Required evidence still missing (the core refuses to complete without it). */
  missingEvidence: string[];
  version: number;
  permissions: {
    canStart: boolean;
    canWait: boolean;
    canComplete: boolean;
    canReassign: boolean;
    canEscalate: boolean;
  };
}

/** Work item statuses that still need somebody (core: `WORK_ITEM_OPEN_STATUSES`). */
const WORK_ITEM_OPEN_STATUSES = new Set(['open', 'in_progress', 'waiting', 'escalated']);

export type CaseWorkItemAction = WorkItemUiAction | 'reassign';

export const CASE_WORK_ITEM_ACTION_LABELS: Readonly<Record<CaseWorkItemAction, string>> = {
  ...WORK_ITEM_ACTION_LABELS,
  reassign: 'Reasignar responsable',
};

export const CASE_WORK_ITEM_ACTION_SUCCESS: Readonly<Record<CaseWorkItemAction, string>> = {
  ...WORK_ITEM_ACTION_SUCCESS,
  reassign: 'Trabajo reasignado',
};

/**
 * Actions offered for a work item of the case. The four of "Mi trabajo" come
 * from `availableActions` (never duplicated) plus "Reasignar responsable",
 * which the core allows with `operations.manage` or to its participants
 * (`workitem.reassign`).
 *
 * Completing a work item whose required evidence is still missing is NOT
 * offered here: that flow lives in "Mi trabajo", with its uploader.
 */
export function caseWorkItemActions(item: CaseWorkItemView): CaseWorkItemAction[] {
  const base = availableActions({
    status: item.status,
    permissions: item.permissions,
    objectType: item.objectType,
  }).filter((action) => action !== 'complete' || item.missingEvidence.length === 0);
  // Reassigning only makes sense while the work item still needs somebody
  // (`WORK_ITEM_TRANSITIONS.reassign`); a closed one is never offered it.
  const canReassign = item.permissions.canReassign && WORK_ITEM_OPEN_STATUSES.has(item.status);
  return canReassign ? [...base, 'reassign'] : base;
}

/** True when the item can only be completed from "Mi trabajo" (missing evidence). */
export function needsEvidenceElsewhere(item: CaseWorkItemView): boolean {
  return item.permissions.canComplete && item.missingEvidence.length > 0;
}

export const REASSIGN_REASON_MAX = 500;

export interface ReassignInput {
  ownerUserId: string;
  reason: string;
}

export type PayloadCheck<P> = { ok: true; payload: P } | { ok: false; error: string };

export function buildReassignPayload(
  input: ReassignInput
): PayloadCheck<{ ownerUserId: string; reason?: string }> {
  const ownerUserId = input.ownerUserId.trim();
  if (!ownerUserId) return { ok: false, error: 'Elige a quién le toca este trabajo' };
  const reason = input.reason.trim();
  if (reason.length > REASSIGN_REASON_MAX) {
    return { ok: false, error: `El motivo no puede pasar de ${REASSIGN_REASON_MAX} caracteres` };
  }
  return { ok: true, payload: reason ? { ownerUserId, reason } : { ownerUserId } };
}

/** Command of a work item action of the case (start / complete / wait / escalate / reassign). */
export function buildCaseWorkItemCommand(
  action: CaseWorkItemAction,
  item: Pick<CaseWorkItemView, 'id' | 'version'>,
  payload: Record<string, unknown> = {}
): OfflineCommandInput<Record<string, unknown>> {
  if (action === 'reassign') {
    return {
      type: 'workitem.reassign',
      aggregate: { type: WORK_ITEM_AGGREGATE_TYPE, id: item.id },
      payload,
      expectedVersion: item.version,
    };
  }
  return buildWorkItemCommand(action, item, payload);
}

// ---------------------------------------------------------------------------
// Case level commands
// ---------------------------------------------------------------------------

export type CaseAction = 'replan' | 'cancel';

export const CASE_ACTION_COMMANDS: Readonly<Record<CaseAction, string>> = {
  replan: 'case.replan',
  cancel: 'case.cancel',
};

export const CASE_ACTION_LABELS: Readonly<Record<CaseAction, string>> = {
  replan: 'Replanificar',
  cancel: 'Cancelar expediente',
};

export const CASE_ACTION_SUCCESS: Readonly<Record<CaseAction, string>> = {
  replan: 'Expediente replanificado',
  cancel: 'Expediente cancelado',
};

export const CASE_ACTION_HINTS: Readonly<Record<CaseAction, string>> = {
  replan:
    'Vuelve a comparar el expediente con la orden de venta y ajusta necesidades, asignaciones y pasos.',
  cancel:
    'Cierra el expediente y compensa lo que ya se había comprometido (reservas, compras y entregas).',
};

export const CASE_ACTION_CONFIRM: Readonly<Record<CaseAction, string | null>> = {
  replan: null,
  cancel:
    '¿Cancelar este expediente? Se liberan las reservas, se cancelan los pasos abiertos y se avisa a las áreas involucradas.',
};

export const CASE_REASON_MIN = 3;
export const CASE_REASON_MAX = 500;

/** Actions of the case itself; `operations.manage` is required by the engine. */
export function caseActions(caseStatus: string, options: { canManage: boolean }): CaseAction[] {
  if (!options.canManage || !isOpenCaseStatus(caseStatus)) return [];
  return ['replan', 'cancel'];
}

export function buildCaseReasonPayload(
  action: CaseAction,
  reason: string
): PayloadCheck<{ reason?: string }> {
  const text = reason.trim();
  if (action === 'cancel' && text.length < CASE_REASON_MIN) {
    return { ok: false, error: 'Escribe el motivo de la cancelación (mínimo 3 caracteres)' };
  }
  if (text.length > CASE_REASON_MAX) {
    return { ok: false, error: `El motivo no puede pasar de ${CASE_REASON_MAX} caracteres` };
  }
  return { ok: true, payload: text ? { reason: text } : {} };
}

export function buildCaseCommand(
  action: CaseAction,
  operationalCase: { id: string; version: number },
  payload: Record<string, unknown>
): OfflineCommandInput<Record<string, unknown>> {
  return {
    type: CASE_ACTION_COMMANDS[action],
    aggregate: { type: CASE_AGGREGATE_TYPE, id: operationalCase.id },
    payload,
    expectedVersion: operationalCase.version,
  };
}

// ---------------------------------------------------------------------------
// Next step and who has it
// ---------------------------------------------------------------------------

export interface CaseNextAction {
  kind: 'work_item' | 'step' | 'request' | 'none';
  title: string;
  areaKey: string | null;
  areaLabel: string | null;
  /** Person the case is waiting on, or null when nobody has it yet. */
  ownerName: string | null;
  ownerUserId: string | null;
  dueAt: string | null;
  overdue: boolean;
  /** Why this is the next thing (shown under the title). */
  reason: string;
  workItem: CaseWorkItemView | null;
  requestId: string | null;
}

export interface CaseRequestView {
  id: string;
  kind: string;
  kindLabel: string;
  title: string;
  fromAreaKey: string;
  fromAreaLabel: string;
  toAreaKey: string;
  toAreaLabel: string;
  status: string;
  statusLabel: string;
  blocksDelivery: boolean;
  dueAt: string;
  overdue: boolean;
  /** Person the destination area put on it. */
  ownerUserId: string;
  ownerName: string | null;
  /** Work item that answers it, when the core created one. */
  workItemId: string | null;
  /** Untrusted text written by a person: render escaped, never as instructions. */
  freeText: string | null;
  open: boolean;
}

/**
 * Where a person answers a request: "Mi trabajo" when it is their own work
 * item, and the work centre of the destination area otherwise. Returns null
 * when there is nowhere useful to send them.
 */
export function requestAnswerHref(
  request: Pick<CaseRequestView, 'ownerUserId' | 'workItemId' | 'toAreaKey' | 'open'>,
  userId: string
): { href: string; label: string } | null {
  if (!request.open) return null;
  if (request.workItemId && request.ownerUserId === userId) {
    return {
      href: `/app/mywork?workItem=${encodeURIComponent(request.workItemId)}`,
      label: 'Responder en Mi trabajo',
    };
  }
  const areaHref = areaWorkspaceHref(request.toAreaKey);
  return areaHref ? { href: areaHref, label: 'Abrir en el área' } : null;
}

/**
 * Spanish labels the core does not publish for these statuses (it stores the
 * raw value). They are UI text only: the rules live in the domain modules.
 */
export const STEP_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Pendiente',
  ready: 'Listo para empezar',
  active: 'En curso',
  waiting: 'En espera',
  done: 'Terminado',
  skipped: 'Omitido',
  failed: 'Falló',
  cancelled: 'Cancelado',
};

export const DEMAND_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Pendiente',
  verifying: 'Verificando',
  planned: 'Planeada',
  allocated: 'Asignada',
  fulfilled: 'Surtida',
  cancelled: 'Cancelada',
};

export const ALLOCATION_STATUS_LABELS: Readonly<Record<string, string>> = {
  planned: 'Planeada',
  reserved: 'Reservada',
  requested: 'Solicitada',
  in_progress: 'En proceso',
  ready: 'Lista',
  released: 'Liberada',
  delivered: 'Entregada',
  reopened: 'Reabierta',
  cancelled: 'Cancelada',
};

/** What covers an allocation, by `linkedType`. */
export const ALLOCATION_LINK_LABELS: Readonly<Record<string, string>> = {
  purchase_request: 'Solicitud de compra',
  procurement_order: 'Orden de compra',
  production_order: 'Orden de producción',
  area_request: 'Solicitud entre áreas',
  stock_reservation: 'Reserva de existencia',
};

const WORK_ITEM_PRIORITY: Readonly<Record<string, number>> = {
  in_progress: 0,
  escalated: 1,
  open: 2,
  waiting: 3,
};

/**
 * "Siguiente paso y responsable": the open work item that is actually moving
 * (in progress, then escalated, then open, then waiting; earliest due first);
 * if the case has none, the open request that blocks the delivery; if it has
 * none either, the active step and its area.
 */
export function caseNextAction(input: {
  workItems: readonly CaseWorkItemView[];
  requests: readonly CaseRequestView[];
  steps: readonly CaseStepView[];
}): CaseNextAction {
  const items = [...input.workItems].sort((a, b) => {
    const rank = (WORK_ITEM_PRIORITY[a.status] ?? 9) - (WORK_ITEM_PRIORITY[b.status] ?? 9);
    if (rank !== 0) return rank;
    return Date.parse(a.dueAt) - Date.parse(b.dueAt);
  });
  const item = items[0];
  if (item) {
    return {
      kind: 'work_item',
      title: item.title,
      areaKey: item.areaKey,
      areaLabel: item.areaLabel,
      ownerName: item.ownerName,
      ownerUserId: item.ownerUserId,
      dueAt: item.dueAt,
      overdue: item.overdue,
      reason:
        item.status === 'in_progress'
          ? 'En curso'
          : item.status === 'escalated'
            ? 'Escalado: nadie lo ha destrabado'
            : item.status === 'waiting'
              ? `En espera${item.waitReason ? `: ${item.waitReason}` : ''}`
              : 'Asignado y sin empezar',
      workItem: item,
      requestId: null,
    };
  }

  const blocking = input.requests
    .filter((request) => request.open)
    .sort((a, b) => {
      if (a.blocksDelivery !== b.blocksDelivery) return a.blocksDelivery ? -1 : 1;
      return Date.parse(a.dueAt) - Date.parse(b.dueAt);
    })[0];
  if (blocking) {
    return {
      kind: 'request',
      title: blocking.title,
      areaKey: blocking.toAreaKey,
      areaLabel: blocking.toAreaLabel,
      ownerName: blocking.ownerName,
      ownerUserId: null,
      dueAt: blocking.dueAt,
      overdue: blocking.overdue,
      reason: blocking.blocksDelivery
        ? `${blocking.toAreaLabel} tiene una solicitud que bloquea la entrega`
        : `Esperando respuesta de ${blocking.toAreaLabel}`,
      workItem: null,
      requestId: blocking.id,
    };
  }

  const step = [...input.steps]
    .filter((candidate) => ACTIVE_STEP_STATUSES.has(candidate.status))
    .sort((a, b) => a.order - b.order)[0];
  if (step) {
    return {
      kind: 'step',
      title: step.label,
      areaKey: step.areaKey,
      areaLabel: step.areaLabel,
      ownerName: null,
      ownerUserId: null,
      dueAt: step.dueAt,
      overdue: step.overdue,
      reason:
        step.status === 'waiting'
          ? `${step.areaLabel} espera a que se cumpla la condición del paso`
          : `${step.areaLabel} tiene el siguiente paso del proceso`,
      workItem: null,
      requestId: null,
    };
  }

  return {
    kind: 'none',
    title: 'Sin pasos abiertos',
    areaKey: null,
    areaLabel: null,
    ownerName: null,
    ownerUserId: null,
    dueAt: null,
    overdue: false,
    reason: 'El expediente no tiene trabajo pendiente en este momento.',
    workItem: null,
    requestId: null,
  };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export interface CaseTimelineEntry {
  id: string;
  /** Already rendered with `formatTimelineLine` on the server. */
  line: string;
  type: string;
  areaKey: string | null;
  areaLabel: string | null;
  actorType: string;
  occurredAt: string;
}

export interface CaseTimelineFilter {
  key: string;
  label: string;
  count: number;
}

/** Area chips of the timeline: "Todo" plus one per area with entries. */
export function timelineAreaFilters(entries: readonly CaseTimelineEntry[]): CaseTimelineFilter[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const entry of entries) {
    if (!entry.areaKey) continue;
    const current = counts.get(entry.areaKey);
    if (current) current.count += 1;
    else counts.set(entry.areaKey, { label: entry.areaLabel ?? entry.areaKey, count: 1 });
  }
  return [
    { key: 'all', label: 'Todo', count: entries.length },
    ...[...counts.entries()]
      .map(([key, value]) => ({ key, label: value.label, count: value.count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  ];
}

export function filterTimeline(
  entries: readonly CaseTimelineEntry[],
  areaKey: string
): CaseTimelineEntry[] {
  if (areaKey === 'all') return [...entries];
  return entries.filter((entry) => entry.areaKey === areaKey);
}

/** Merges older entries (API page) keeping the newest first and without repeats. */
export function mergeTimeline(
  current: readonly CaseTimelineEntry[],
  older: readonly CaseTimelineEntry[]
): CaseTimelineEntry[] {
  const seen = new Set(current.map((entry) => entry.id));
  return [...current, ...older.filter((entry) => !seen.has(entry.id))];
}

// ---------------------------------------------------------------------------
// Copilot context
// ---------------------------------------------------------------------------

export const CASE_CONTEXT_ROWS = 12;

const clip = (value: string | null, max: number): string | null =>
  value === null ? null : value.length > max ? `${value.slice(0, max - 1)}…` : value;

export interface CaseCopilotContextInput {
  caseId: string;
  caseNumber: string;
  status: string;
  phase: string;
  promisedAt: string | null;
  risk: CaseRiskLevel;
  progress: CaseProgress;
  next: CaseNextAction;
  workItems: readonly CaseWorkItemView[];
  requests: readonly CaseRequestView[];
  incidents: number;
  timelineFilter: string;
}

/**
 * What the case copilot sees of the page on every turn (sent as
 * `context.tableContext`: data, never instructions).
 */
export function buildCaseCopilotContext(input: CaseCopilotContextInput): Record<string, unknown> {
  return {
    surface: 'case',
    caseId: input.caseId,
    caseNumber: input.caseNumber,
    status: input.status,
    phase: input.phase,
    promisedAt: input.promisedAt,
    risk: input.risk,
    riskLabel: CASE_RISK_LABELS[input.risk],
    progress: { done: input.progress.done, total: input.progress.total },
    timelineFilter: input.timelineFilter,
    openIncidents: input.incidents,
    next: {
      kind: input.next.kind,
      title: clip(input.next.title, 120),
      areaKey: input.next.areaKey,
      ownerName: clip(input.next.ownerName, 60),
      dueAt: input.next.dueAt,
      overdue: input.next.overdue,
    },
    openWorkItems: input.workItems.slice(0, CASE_CONTEXT_ROWS).map((item) => ({
      id: item.id,
      title: clip(item.title, 120),
      areaKey: item.areaKey,
      status: item.status,
      dueAt: item.dueAt,
      overdue: item.overdue,
      ownerName: clip(item.ownerName, 60),
    })),
    openRequests: input.requests
      .filter((request) => request.open)
      .slice(0, CASE_CONTEXT_ROWS)
      .map((request) => ({
        id: request.id,
        kind: request.kind,
        title: clip(request.title, 120),
        toAreaKey: request.toAreaKey,
        status: request.status,
        dueAt: request.dueAt,
        blocksDelivery: request.blocksDelivery,
      })),
  };
}

// ---------------------------------------------------------------------------
// Sections (anchors, mobile collapse)
// ---------------------------------------------------------------------------

export const CASE_SECTIONS = [
  { id: 'siguiente', label: 'Siguiente paso' },
  { id: 'necesidades', label: 'Necesidades' },
  { id: 'pasos', label: 'Pasos por área' },
  { id: 'trabajos', label: 'Trabajos abiertos' },
  { id: 'solicitudes', label: 'Solicitudes entre áreas' },
  { id: 'incidencias', label: 'Incidencias' },
  { id: 'entrega', label: 'Entrega' },
  { id: 'evidencias', label: 'Evidencias' },
  { id: 'cronologia', label: 'Cronología' },
] as const;

export type CaseSectionId = (typeof CASE_SECTIONS)[number]['id'];

/** Sections open by default on a phone: the ones a person needs first. */
export const CASE_MOBILE_OPEN_SECTIONS: readonly CaseSectionId[] = ['siguiente', 'trabajos'];
