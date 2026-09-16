/**
 * Reproducción cronológica de un expediente (plan 7.8d). Módulo PURO.
 *
 * `foldCaseState(events, at)` aplica la bitácora `OperationalEvent` en orden y
 * devuelve el estado del expediente en ese instante: fase, estado, pasos, work
 * items, solicitudes e incidencias. No consulta la base: el estado sale de los
 * hechos, que es justamente lo que permite "rebobinar" sin guardar fotos.
 *
 * Los eventos de auditoría de la IA (`ai.*`) no cambian el estado del negocio y
 * se ignoran aquí (el llamador ya los excluye con `AI_TURN_EVENT_TYPES`).
 */

export interface ReplayEvent {
  id: string;
  type: string;
  occurredAt: string | Date;
  areaKey?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface ReplayStep {
  ref: string;
  stepKey: string;
  scopeKey: string;
  areaKey: string | null;
  status: 'pending' | 'ready' | 'active' | 'waiting' | 'done' | 'skipped' | 'cancelled' | 'failed';
  dueAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  waitReason: string | null;
}

export interface ReplayWorkItem {
  id: string;
  title: string;
  areaKey: string | null;
  status: 'open' | 'in_progress' | 'waiting' | 'escalated' | 'done' | 'cancelled';
  ownerUserId: string | null;
  backupUserId: string | null;
  dueAt: string | null;
  escalationLevel: number;
  waitReason: string | null;
}

export interface ReplayRequest {
  id: string;
  kind: string;
  fromAreaKey: string | null;
  toAreaKey: string | null;
  status:
    | 'sent'
    | 'acknowledged'
    | 'accepted'
    | 'blocked'
    | 'resolved'
    | 'rejected'
    | 'cancelled'
    | 'expired';
  blocksDelivery: boolean;
  ownerUserId: string | null;
  dueAt: string | null;
}

export interface ReplayIncident {
  id: string;
  kind: string;
  severity: string;
  status: 'open' | 'acknowledged' | 'resolved' | 'dismissed';
  title: string;
  areaKey: string | null;
}

export interface ReplayCaseState {
  /** Instante reproducido (ISO). */
  at: string;
  eventsApplied: number;
  lastEventId: string | null;
  lastEventAt: string | null;
  caseNumber: string | null;
  customerName: string | null;
  salesOrderNumber: string | null;
  ownerUserId: string | null;
  status: string;
  phase: string;
  started: boolean;
  delivered: boolean;
  closedAt: string | null;
  cancelledAt: string | null;
  steps: ReplayStep[];
  workItems: ReplayWorkItem[];
  requests: ReplayRequest[];
  incidents: ReplayIncident[];
  counters: {
    openSteps: number;
    openWorkItems: number;
    openRequests: number;
    openIncidents: number;
    blockingRequests: number;
    overdueWorkItems: number;
  };
}

const OPEN_STEP_STATUSES = new Set(['ready', 'active', 'waiting']);
const OPEN_WORK_STATUSES = new Set(['open', 'in_progress', 'waiting', 'escalated']);
const OPEN_REQUEST_STATUSES = new Set(['sent', 'acknowledged', 'accepted', 'blocked']);
const OPEN_INCIDENT_STATUSES = new Set(['open', 'acknowledged']);

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toMs(value: string | Date | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(toMs(value)).toISOString();
}

/** Instantes distintos de la bitácora: alimentan el deslizador del reproductor. */
export function replayTimestamps(events: readonly ReplayEvent[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const event of events) {
    const at = iso(event.occurredAt);
    if (seen.has(at)) continue;
    seen.add(at);
    out.push(at);
  }
  return out.sort();
}

function sortedEvents(events: readonly ReplayEvent[]): ReplayEvent[] {
  return [...events].sort((a, b) => {
    const diff = toMs(a.occurredAt) - toMs(b.occurredAt);
    if (diff !== 0) return diff;
    const left = a.id ?? '';
    const right = b.id ?? '';
    if (left.length !== right.length) return left.length - right.length; // ids numéricos como texto
    return left.localeCompare(right);
  });
}

/**
 * Estado del expediente al instante `at` (por omisión, el del último evento).
 * Los eventos posteriores a `at` no se aplican.
 */
export function foldCaseState(
  events: readonly ReplayEvent[],
  at?: string | Date | null
): ReplayCaseState {
  const ordered = sortedEvents(events);
  const cutoff = at === undefined || at === null ? Number.POSITIVE_INFINITY : toMs(at);

  const steps = new Map<string, ReplayStep>();
  const workItems = new Map<string, ReplayWorkItem>();
  const requests = new Map<string, ReplayRequest>();
  const incidents = new Map<string, ReplayIncident>();

  const state: ReplayCaseState = {
    at: at === undefined || at === null ? '' : iso(at),
    eventsApplied: 0,
    lastEventId: null,
    lastEventAt: null,
    caseNumber: null,
    customerName: null,
    salesOrderNumber: null,
    ownerUserId: null,
    status: 'open',
    phase: 'planning',
    started: false,
    delivered: false,
    closedAt: null,
    cancelledAt: null,
    steps: [],
    workItems: [],
    requests: [],
    incidents: [],
    counters: {
      openSteps: 0,
      openWorkItems: 0,
      openRequests: 0,
      openIncidents: 0,
      blockingRequests: 0,
      overdueWorkItems: 0,
    },
  };

  const stepRef = (payload: Record<string, unknown>): string | null => {
    const stepKey = str(payload.stepKey);
    if (!stepKey) return null;
    const scopeKey = typeof payload.scopeKey === 'string' ? payload.scopeKey : '';
    return `${stepKey}\x00${scopeKey}`;
  };

  const upsertStep = (
    payload: Record<string, unknown>,
    areaKey: string | null,
    patch: Partial<ReplayStep>
  ): void => {
    const ref = stepRef(payload);
    if (!ref) return;
    const [stepKey, scopeKey] = ref.split('\x00');
    const current: ReplayStep = steps.get(ref) ?? {
      ref,
      stepKey,
      scopeKey,
      areaKey,
      status: 'pending',
      dueAt: null,
      startedAt: null,
      completedAt: null,
      waitReason: null,
    };
    steps.set(ref, { ...current, areaKey: areaKey ?? current.areaKey, ...patch });
  };

  const upsertWorkItem = (id: string, patch: Partial<ReplayWorkItem>): void => {
    const current: ReplayWorkItem = workItems.get(id) ?? {
      id,
      title: '',
      areaKey: null,
      status: 'open',
      ownerUserId: null,
      backupUserId: null,
      dueAt: null,
      escalationLevel: 0,
      waitReason: null,
    };
    workItems.set(id, { ...current, ...patch });
  };

  const upsertRequest = (id: string, patch: Partial<ReplayRequest>): void => {
    const current: ReplayRequest = requests.get(id) ?? {
      id,
      kind: 'info',
      fromAreaKey: null,
      toAreaKey: null,
      status: 'sent',
      blocksDelivery: false,
      ownerUserId: null,
      dueAt: null,
    };
    requests.set(id, { ...current, ...patch });
  };

  const upsertIncident = (id: string, patch: Partial<ReplayIncident>): void => {
    const current: ReplayIncident = incidents.get(id) ?? {
      id,
      kind: 'sla_breach',
      severity: 'medium',
      status: 'open',
      title: '',
      areaKey: null,
    };
    incidents.set(id, { ...current, ...patch });
  };

  for (const event of ordered) {
    const occurredMs = toMs(event.occurredAt);
    if (occurredMs > cutoff) break;
    if (event.type.startsWith('ai.')) continue;
    state.eventsApplied += 1;
    state.lastEventId = event.id ?? state.lastEventId;
    state.lastEventAt = iso(event.occurredAt);
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const areaKey = event.areaKey ?? null;

    switch (event.type) {
      case 'case.created':
      case 'case.started':
        state.started = true;
        state.caseNumber = str(payload.caseNumber) ?? state.caseNumber;
        state.customerName = str(payload.customerName) ?? state.customerName;
        state.salesOrderNumber = str(payload.salesOrderNumber) ?? state.salesOrderNumber;
        state.ownerUserId = str(payload.ownerUserId) ?? state.ownerUserId;
        break;
      case 'case.status_changed':
        state.status = str(payload.to) ?? state.status;
        if (state.status === 'closed') state.closedAt = iso(event.occurredAt);
        break;
      case 'case.phase_changed':
        state.phase = str(payload.to) ?? state.phase;
        break;
      case 'case.owner_changed':
        state.ownerUserId = str(payload.ownerUserId) ?? state.ownerUserId;
        break;
      case 'case.delivered':
        state.delivered = true;
        break;
      case 'case.cancelled':
        state.status = 'cancelled';
        state.cancelledAt = iso(event.occurredAt);
        break;
      case 'case.operational_closed':
        state.phase = 'closing';
        break;

      case 'step.ready':
        upsertStep(payload, str(payload.areaKey) ?? areaKey, {
          status: 'ready',
          dueAt: str(payload.dueAt),
        });
        break;
      case 'step.started':
        upsertStep(payload, areaKey, {
          status: 'active',
          startedAt: iso(event.occurredAt),
          waitReason: null,
        });
        break;
      case 'step.waiting':
        upsertStep(payload, areaKey, {
          status: 'waiting',
          waitReason: str(payload.reason),
          dueAt: str(payload.dueAt),
        });
        break;
      case 'step.completed':
        upsertStep(payload, areaKey, {
          status: 'done',
          completedAt: iso(event.occurredAt),
          waitReason: null,
        });
        break;
      case 'step.skipped':
        upsertStep(payload, areaKey, { status: 'skipped' });
        break;
      case 'step.cancelled':
        upsertStep(payload, areaKey, { status: 'cancelled' });
        break;
      case 'step.failed':
      case 'step.engine_failed':
        upsertStep(payload, areaKey, { status: 'failed' });
        break;
      case 'step.reopened':
      case 'step.reverted':
        upsertStep(payload, areaKey, { status: 'ready', completedAt: null });
        break;

      case 'workitem.created':
        upsertWorkItem(str(payload.workItemId) ?? event.objectId ?? '', {
          title: str(payload.title) ?? '',
          areaKey,
          status: 'open',
          ownerUserId: str(payload.ownerUserId),
          backupUserId: str(payload.backupUserId),
          dueAt: str(payload.dueAt),
        });
        break;
      case 'workitem.started':
        upsertWorkItem(str(payload.workItemId) ?? event.objectId ?? '', {
          status: 'in_progress',
          waitReason: null,
        });
        break;
      case 'workitem.waiting':
        upsertWorkItem(str(payload.workItemId) ?? event.objectId ?? '', {
          status: 'waiting',
          waitReason: str(payload.reason),
        });
        break;
      case 'workitem.completed':
        upsertWorkItem(str(payload.workItemId) ?? event.objectId ?? '', {
          status: 'done',
          waitReason: null,
        });
        break;
      case 'workitem.cancelled':
        upsertWorkItem(str(payload.workItemId) ?? event.objectId ?? '', { status: 'cancelled' });
        break;
      case 'workitem.reassigned':
      case 'workitem.assigned':
        upsertWorkItem(str(payload.workItemId) ?? event.objectId ?? '', {
          ownerUserId: str(payload.ownerUserId),
          backupUserId: str(payload.backupUserId),
          ...(str(payload.dueAt) ? { dueAt: str(payload.dueAt) } : {}),
        });
        break;
      case 'workitem.escalated':
        upsertWorkItem(str(payload.workItemId) ?? event.objectId ?? '', {
          status: 'escalated',
          escalationLevel: num(payload.level) ?? 1,
        });
        break;

      case 'request.created':
        upsertRequest(str(payload.requestId) ?? event.objectId ?? '', {
          kind: str(payload.kind) ?? 'info',
          fromAreaKey: str(payload.fromAreaKey),
          toAreaKey: str(payload.toAreaKey),
          status: 'sent',
          blocksDelivery: payload.blocksDelivery === true,
          ownerUserId: str(payload.ownerUserId),
          dueAt: str(payload.dueAt),
        });
        break;
      case 'request.acknowledged':
      case 'request.accepted':
      case 'request.blocked':
      case 'request.resolved':
      case 'request.rejected':
      case 'request.cancelled':
      case 'request.expired': {
        const status = event.type.slice('request.'.length) as ReplayRequest['status'];
        upsertRequest(str(payload.requestId) ?? event.objectId ?? '', { status });
        break;
      }

      case 'incident.opened':
        upsertIncident(str(payload.incidentId) ?? event.objectId ?? '', {
          kind: str(payload.kind) ?? 'sla_breach',
          severity: str(payload.severity) ?? 'medium',
          status: 'open',
          title: str(payload.title) ?? '',
          areaKey,
        });
        break;
      case 'incident.acknowledged':
      case 'incident.resolved':
      case 'incident.dismissed': {
        const status = event.type.slice('incident.'.length) as ReplayIncident['status'];
        upsertIncident(str(payload.incidentId) ?? event.objectId ?? '', { status });
        break;
      }
      default:
        break;
    }
  }

  if (!state.at) state.at = state.lastEventAt ?? new Date(0).toISOString();
  const atMs = toMs(state.at);

  state.steps = [...steps.values()].filter((step) => step.stepKey);
  state.workItems = [...workItems.values()].filter((item) => item.id);
  state.requests = [...requests.values()].filter((request) => request.id);
  state.incidents = [...incidents.values()].filter((incident) => incident.id);

  state.counters = {
    openSteps: state.steps.filter((step) => OPEN_STEP_STATUSES.has(step.status)).length,
    openWorkItems: state.workItems.filter((item) => OPEN_WORK_STATUSES.has(item.status)).length,
    openRequests: state.requests.filter((request) => OPEN_REQUEST_STATUSES.has(request.status))
      .length,
    openIncidents: state.incidents.filter((incident) => OPEN_INCIDENT_STATUSES.has(incident.status))
      .length,
    blockingRequests: state.requests.filter(
      (request) =>
        OPEN_REQUEST_STATUSES.has(request.status) &&
        (request.blocksDelivery || request.status === 'blocked')
    ).length,
    overdueWorkItems: state.workItems.filter(
      (item) =>
        OPEN_WORK_STATUSES.has(item.status) && item.dueAt !== null && toMs(item.dueAt) < atMs
    ).length,
  };

  return state;
}
