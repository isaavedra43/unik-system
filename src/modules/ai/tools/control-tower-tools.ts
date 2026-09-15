import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { SALES_FULFILLMENT_BLUEPRINT } from '@/modules/operations/process-blueprints/sales-fulfillment';
import {
  AREA_KEYS,
  AREA_LABELS,
  AREA_REQUEST_OPEN_STATUSES,
  CASE_OPEN_STATUSES,
  CASE_PHASE_LABELS,
  CASE_STATUS_LABELS,
  INCIDENT_OPEN_STATUSES,
  INCIDENT_SEVERITY_LABELS,
  WORK_ITEM_OPEN_STATUSES,
  type AreaKey,
} from '@/modules/operations/types';
import type { CurrentUser } from '@/modules/auth/authorization';
import {
  OperationsToolError,
  areaName,
  botScopeOf,
  localDayKey,
  localDayStart,
  registerOperationsTool,
  resolveCase,
  truncateText,
  userNames,
} from './operations-tool-kit';

/**
 * Control Tower tools of the administrator identity (plan 5.5, `operations.admin`):
 * company pulse, stuck cases, who is blocking and a pure delay simulation over
 * the blueprint dependencies (`dependsOn` / `slaMinutes`). Readings only; they
 * live in the control tower surface (orchestrator constant).
 *
 * People need `operations.admin`. The administrator agent identity (`agent_admin`)
 * reads them too without holding that permission, which configures the core and
 * is the fallback approver of business approvals (agents/permissions.ts).
 */

/** The administrator bot (fixed `agent_admin` role with `operations.view`). Pure. */
/** The administrator AI identity (`User.isBot` + `agent_admin`), never a person holding that role. */
export function isAdministratorBot(actor: CurrentUser): boolean {
  return actor.isBot === true && botScopeOf(actor) === 'admin' && actor.permissionKeys.includes('operations.view' as never);
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

const label = (labels: Record<string, string>, key: string) => labels[key] ?? key;

// ---------------------------------------------------------------------------
// Pure builders (tested)
// ---------------------------------------------------------------------------

export interface PulseInput {
  now: Date;
  casesByStatus: Array<{ status: string; count: number }>;
  casesByPhase: Array<{ phase: string; count: number }>;
  openedToday: number;
  deliveredToday: number;
  stuck24h: number;
  workOpenByArea: Array<{ areaKey: string; count: number }>;
  workOverdueByArea: Array<{ areaKey: string; count: number }>;
  requestsOpenByArea: Array<{ areaKey: string; count: number }>;
  requestsOverdueByArea: Array<{ areaKey: string; count: number }>;
  blockingRequests: number;
  incidentsBySeverity: Array<{ severity: string; count: number }>;
  pendingApprovals: number;
  aiByArea?: Array<{ areaKey: string; tokens: number; usd: number }> | null;
}

export function buildCompanyPulse(input: PulseInput) {
  const sumBy = (rows: Array<{ areaKey: string; count: number }>, key: AreaKey) =>
    rows.filter((r) => r.areaKey === key).reduce((s, r) => s + r.count, 0);
  const openCases = input.casesByStatus.reduce((s, r) => s + r.count, 0);
  const areas = AREA_KEYS.map((areaKey) => {
    const ai = input.aiByArea?.find((row) => row.areaKey === areaKey);
    return {
      areaKey,
      label: AREA_LABELS[areaKey],
      openWorkItems: sumBy(input.workOpenByArea, areaKey),
      overdueWorkItems: sumBy(input.workOverdueByArea, areaKey),
      openRequests: sumBy(input.requestsOpenByArea, areaKey),
      overdueRequests: sumBy(input.requestsOverdueByArea, areaKey),
      aiTokensToday: ai?.tokens ?? null,
      aiUsdToday: ai?.usd ?? null,
    };
  });
  const incidentsOpen = input.incidentsBySeverity.reduce((s, r) => s + r.count, 0);
  const severe = input.incidentsBySeverity
    .filter((r) => r.severity === 'critical' || r.severity === 'high')
    .reduce((s, r) => s + r.count, 0);
  const worst = [...areas]
    .filter((a) => a.overdueWorkItems + a.overdueRequests > 0)
    .sort((a, b) => b.overdueWorkItems + b.overdueRequests - (a.overdueWorkItems + a.overdueRequests))
    .slice(0, 3);
  const aiTokens = input.aiByArea ? input.aiByArea.reduce((s, r) => s + r.tokens, 0) : null;
  const headline = [
    `${openCases} expedientes abiertos · ${input.openedToday} nuevos hoy · ${input.deliveredToday} entregados hoy · ${input.stuck24h} sin movimiento en 24 h.`,
    worst.length > 0
      ? `Más atraso: ${worst.map((a) => `${a.label} (${a.overdueWorkItems} trabajos y ${a.overdueRequests} solicitudes vencidas)`).join(', ')}.`
      : 'Sin trabajos ni solicitudes vencidas.',
    `${input.blockingRequests} solicitudes bloquean entregas · ${incidentsOpen} incidencias abiertas (${severe} altas o críticas) · ${input.pendingApprovals} aprobaciones pendientes.`,
    aiTokens !== null ? `IA hoy: ${aiTokens.toLocaleString('es-MX')} tokens.` : null,
  ].filter((line): line is string => Boolean(line));
  return {
    date: localDayKey(input.now),
    cases: {
      open: openCases,
      openedToday: input.openedToday,
      deliveredToday: input.deliveredToday,
      stuck24h: input.stuck24h,
      byStatus: input.casesByStatus.map((r) => ({ status: r.status, label: label(CASE_STATUS_LABELS, r.status), count: r.count })),
      byPhase: input.casesByPhase.map((r) => ({ phase: r.phase, label: label(CASE_PHASE_LABELS, r.phase), count: r.count })),
    },
    areas,
    blockingRequests: input.blockingRequests,
    incidents: {
      open: incidentsOpen,
      bySeverity: input.incidentsBySeverity.map((r) => ({ severity: r.severity, label: label(INCIDENT_SEVERITY_LABELS, r.severity), count: r.count })),
    },
    pendingApprovals: input.pendingApprovals,
    headline,
  };
}

export interface StuckCaseInput {
  id: string;
  caseNumber: string;
  salesOrderNumber: string | null;
  customerName: string | null;
  status: string;
  phase: string;
  ownerName: string | null;
  lastActivityAt: Date;
  promisedAt: Date | null;
  orphan: boolean;
  openWorkItems: Array<{ ownerName: string | null; dueAt: Date; areaKey: string }>;
  openRequests: Array<{ toAreaKey: string; blocksDelivery: boolean; status: string; dueAt: Date }>;
}

/** What to do with a stuck case (pure). */
export function classifyStuckCase(input: StuckCaseInput, now: Date) {
  const overdue = input.openWorkItems.filter((w) => w.dueAt.getTime() < now.getTime());
  const blocking = input.openRequests.filter((r) => r.blocksDelivery || r.status === 'blocked');
  const waitingOn = [...new Set(blocking.map((r) => areaName(r.toAreaKey)))];
  const overdueOwners = [...new Set(overdue.map((w) => w.ownerName).filter((n): n is string => Boolean(n)))];
  let suggestion: string;
  if (input.orphan) suggestion = 'Sin trabajo pendiente ni espera activa: revisa el plan o avanza el expediente';
  else if (blocking.length > 0) suggestion = `Esperando a ${waitingOn.join(', ')}: da seguimiento a la solicitud o escálala`;
  else if (overdue.length > 0) suggestion = `Trabajo vencido de ${overdueOwners.join(', ') || 'su responsable'}: escala o reasigna`;
  else suggestion = 'Sin movimiento: confirma con el responsable del paso en curso';
  return {
    caseId: input.id,
    caseNumber: input.caseNumber,
    salesOrderNumber: input.salesOrderNumber,
    customerName: input.customerName,
    status: label(CASE_STATUS_LABELS, input.status),
    phase: label(CASE_PHASE_LABELS, input.phase),
    owner: input.ownerName,
    idleHours: Math.floor((now.getTime() - input.lastActivityAt.getTime()) / HOUR),
    promisedAt: input.promisedAt?.toISOString() ?? null,
    promiseAtRisk: Boolean(input.promisedAt && input.promisedAt.getTime() < now.getTime() + 24 * HOUR),
    orphan: input.orphan,
    openWorkItems: input.openWorkItems.length,
    overdueWorkItems: overdue.length,
    blockingRequests: blocking.length,
    waitingOn,
    suggestion,
  };
}

export interface BlockerWorkItem {
  id: string;
  caseId: string | null;
  areaKey: string;
  ownerUserId: string;
  title: string;
  dueAt: Date;
  escalationLevel: number;
}

export interface BlockerRequest {
  id: string;
  caseId: string;
  toAreaKey: string;
  ownerUserId: string;
  title: string;
  dueAt: Date;
  status: string;
  blocksDelivery: boolean;
}

/** People holding overdue work or blocking requests, longest delay first (pure). */
export function rankBlockers(input: {
  items: BlockerWorkItem[];
  requests: BlockerRequest[];
  now: Date;
  names: ReadonlyMap<string, string>;
  caseNumbers: ReadonlyMap<string, string>;
}) {
  interface Group {
    userId: string;
    name: string | null;
    areas: Set<string>;
    cases: Set<string>;
    overdueWorkItems: number;
    blockingRequests: number;
    oldestOverdueMinutes: number;
    examples: string[];
  }
  const groups = new Map<string, Group>();
  const now = input.now.getTime();
  const groupOf = (userId: string) => {
    let group = groups.get(userId);
    if (!group) {
      group = {
        userId,
        name: input.names.get(userId) ?? null,
        areas: new Set(),
        cases: new Set(),
        overdueWorkItems: 0,
        blockingRequests: 0,
        oldestOverdueMinutes: 0,
        examples: [],
      };
      groups.set(userId, group);
    }
    return group;
  };
  const caseLabel = (caseId: string | null) => (caseId ? (input.caseNumbers.get(caseId) ?? null) : null);
  for (const item of input.items) {
    const group = groupOf(item.ownerUserId);
    const minutes = Math.max(0, Math.floor((now - item.dueAt.getTime()) / MINUTE));
    group.overdueWorkItems += 1;
    group.areas.add(areaName(item.areaKey));
    const number = caseLabel(item.caseId);
    if (number) group.cases.add(number);
    group.oldestOverdueMinutes = Math.max(group.oldestOverdueMinutes, minutes);
    if (group.examples.length < 3) group.examples.push(`${truncateText(item.title, 80)}${number ? ` (${number})` : ''}`);
  }
  for (const request of input.requests) {
    const group = groupOf(request.ownerUserId);
    const minutes = Math.max(0, Math.floor((now - request.dueAt.getTime()) / MINUTE));
    group.blockingRequests += 1;
    group.areas.add(areaName(request.toAreaKey));
    const number = caseLabel(request.caseId);
    if (number) group.cases.add(number);
    group.oldestOverdueMinutes = Math.max(group.oldestOverdueMinutes, minutes);
    if (group.examples.length < 3) {
      group.examples.push(`Solicitud «${truncateText(request.title, 80)}»${request.status === 'blocked' ? ' bloqueada' : ''}${number ? ` (${number})` : ''}`);
    }
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        b.oldestOverdueMinutes - a.oldestOverdueMinutes ||
        b.overdueWorkItems + b.blockingRequests - (a.overdueWorkItems + a.blockingRequests)
    )
    .map((g) => ({
      userId: g.userId,
      name: g.name,
      areas: [...g.areas],
      cases: [...g.cases],
      overdueWorkItems: g.overdueWorkItems,
      blockingRequests: g.blockingRequests,
      oldestOverdueHours: Math.round((g.oldestOverdueMinutes / 60) * 10) / 10,
      examples: g.examples,
    }));
}

export interface SimulationStep {
  /** `stepKey:scopeKey` (the format of `CaseStep.dependsOn`). */
  ref: string;
  stepKey: string;
  scopeKey: string;
  label: string;
  areaKey: string;
  dependsOn: string[];
  slaMinutes: number;
  status: string;
  dueAt: Date | null;
  completedAt: Date | null;
}

const TERMINAL_STEP = new Set(['done', 'skipped', 'cancelled']);
const OPEN_STEP = new Set(['ready', 'active', 'waiting']);

/**
 * Projected finish (epoch ms) of every step (pure): terminal steps finish when
 * they did; open steps at their due date (or now + SLA), never before now;
 * pending steps after their last dependency plus their SLA. `delays` (minutes by
 * ref) push the finish of a step and, through `dependsOn`, of its successors.
 */
export function projectStepFinishes(
  steps: readonly SimulationStep[],
  options: { start: Date; now: Date; delays?: ReadonlyMap<string, number> }
): Map<string, number> {
  const byRef = new Map(steps.map((step) => [step.ref, step]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const startMs = options.start.getTime();
  const nowMs = Math.max(options.now.getTime(), startMs);

  const finish = (ref: string): number => {
    const cached = memo.get(ref);
    if (cached !== undefined) return cached;
    const step = byRef.get(ref);
    if (!step || visiting.has(ref)) return startMs;
    visiting.add(ref);
    const delay = Math.max(0, options.delays?.get(ref) ?? 0) * MINUTE;
    const sla = Math.max(0, step.slaMinutes) * MINUTE;
    const depsDone = Math.max(startMs, ...step.dependsOn.map(finish));
    let value: number;
    if (TERMINAL_STEP.has(step.status)) {
      value = step.completedAt?.getTime() ?? depsDone;
    } else if (OPEN_STEP.has(step.status)) {
      const planned = step.dueAt ? step.dueAt.getTime() : Math.max(nowMs, depsDone) + sla;
      value = Math.max(planned, nowMs) + delay;
    } else {
      value = Math.max(nowMs, depsDone) + sla + delay;
    }
    visiting.delete(ref);
    memo.set(ref, value);
    return value;
  };

  for (const step of steps) finish(step.ref);
  return memo;
}

export interface DelaySimulation {
  target: { stepKey: string; scopeKey: string | null; refs: string[]; label: string };
  delayMinutes: number;
  baselineFinish: string | null;
  delayedFinish: string | null;
  shiftMinutes: number;
  affected: Array<{
    ref: string;
    stepKey: string;
    scopeKey: string;
    label: string;
    areaKey: string;
    areaLabel: string;
    before: string;
    after: string;
    shiftMinutes: number;
  }>;
  unaffectedOpenSteps: number;
  promisedAt: string | null;
  lateBefore: boolean | null;
  lateAfter: boolean | null;
}

/** Delays a step and reports what moves (pure). Throws when the step is unknown or already finished. */
export function simulateStepDelay(
  steps: readonly SimulationStep[],
  input: { stepKey: string; scopeKey?: string | null; delayMinutes: number; now: Date; start?: Date; promisedAt?: Date | null }
): DelaySimulation {
  const targets = steps.filter(
    (step) => step.stepKey === input.stepKey && (input.scopeKey === undefined || input.scopeKey === null || step.scopeKey === input.scopeKey)
  );
  if (targets.length === 0) {
    const keys = [...new Set(steps.map((s) => s.stepKey))].slice(0, 20).join(', ');
    throw new OperationsToolError(`No existe el paso ${input.stepKey}. Pasos: ${keys}`, 'invalid_args');
  }
  const open = targets.filter((step) => !TERMINAL_STEP.has(step.status));
  if (open.length === 0) throw new OperationsToolError(`El paso ${targets[0].label} ya terminó; no se puede retrasar`, 'invalid_state');
  const delayMinutes = Math.max(0, Math.round(input.delayMinutes));
  const start = input.start ?? input.now;
  const baseline = projectStepFinishes(steps, { start, now: input.now });
  const delayed = projectStepFinishes(steps, {
    start,
    now: input.now,
    delays: new Map(open.map((step) => [step.ref, delayMinutes])),
  });
  const pending = steps.filter((step) => !TERMINAL_STEP.has(step.status));
  const lastOf = (projection: Map<string, number>) => {
    const values = (pending.length > 0 ? pending : steps).map((step) => projection.get(step.ref) ?? 0);
    return values.length > 0 ? Math.max(...values) : null;
  };
  const baselineFinish = lastOf(baseline);
  const delayedFinish = lastOf(delayed);
  const affected = steps
    .filter((step) => (delayed.get(step.ref) ?? 0) !== (baseline.get(step.ref) ?? 0))
    .map((step) => {
      const before = baseline.get(step.ref) ?? 0;
      const after = delayed.get(step.ref) ?? 0;
      return {
        ref: step.ref,
        stepKey: step.stepKey,
        scopeKey: step.scopeKey,
        label: step.label,
        areaKey: step.areaKey,
        areaLabel: areaName(step.areaKey),
        before: new Date(before).toISOString(),
        after: new Date(after).toISOString(),
        shiftMinutes: Math.round((after - before) / MINUTE),
      };
    })
    .sort((a, b) => a.after.localeCompare(b.after));
  const promised = input.promisedAt?.getTime() ?? null;
  return {
    target: { stepKey: input.stepKey, scopeKey: input.scopeKey ?? null, refs: open.map((s) => s.ref), label: open[0].label },
    delayMinutes,
    baselineFinish: baselineFinish === null ? null : new Date(baselineFinish).toISOString(),
    delayedFinish: delayedFinish === null ? null : new Date(delayedFinish).toISOString(),
    shiftMinutes: baselineFinish !== null && delayedFinish !== null ? Math.round((delayedFinish - baselineFinish) / MINUTE) : 0,
    affected,
    unaffectedOpenSteps: pending.filter((step) => !affected.some((a) => a.ref === step.ref)).length,
    promisedAt: input.promisedAt?.toISOString() ?? null,
    lateBefore: promised !== null && baselineFinish !== null ? baselineFinish > promised : null,
    lateAfter: promised !== null && delayedFinish !== null ? delayedFinish > promised : null,
  };
}

/** Blueprint `sales_fulfillment@1` as a simulation template (every path, nothing started). */
export function blueprintSimulationSteps(): SimulationStep[] {
  return SALES_FULFILLMENT_BLUEPRINT.steps.map((step) => ({
    ref: step.key,
    stepKey: step.key,
    scopeKey: '',
    label: step.label,
    areaKey: step.areaKey,
    dependsOn: [...step.dependsOn],
    slaMinutes: step.slaMinutes,
    status: 'pending',
    dueAt: null,
    completedAt: null,
  }));
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const countRows = <K extends string>(rows: Array<Record<K, string> & { _count: { _all: number } }>, key: K) =>
  rows.map((row) => ({ key: row[key], count: row._count._all }));

registerOperationsTool({
  name: 'getCompanyPulse',
  description:
    'Pulso de la empresa para la Torre de Control: expedientes abiertos por estado y fase, nuevos y entregados hoy, atrasos por área, solicitudes que bloquean entregas, incidencias, aprobaciones pendientes y consumo de IA del día.',
  requiredPermission: 'operations.admin',
  allowActor: isAdministratorBot,
  effect: 'read',
  parameters: z.object({}).describe('Sin parámetros.'),
  execute: async () => {
    const now = new Date();
    const dayStart = localDayStart(now);
    const openCases = { status: { in: [...CASE_OPEN_STATUSES] } };
    const openWork = { status: { in: [...WORK_ITEM_OPEN_STATUSES] } };
    const openRequests = { status: { in: [...AREA_REQUEST_OPEN_STATUSES] } };
    const [
      byStatus,
      byPhase,
      openedToday,
      deliveredToday,
      stuck24h,
      workOpen,
      workOverdue,
      requestsOpen,
      requestsOverdue,
      blockingRequests,
      incidents,
      pendingApprovals,
    ] = await Promise.all([
      prisma.operationalCase.groupBy({ by: ['status'], where: openCases, _count: { _all: true } }),
      prisma.operationalCase.groupBy({ by: ['phase'], where: openCases, _count: { _all: true } }),
      prisma.operationalCase.count({ where: { openedAt: { gte: dayStart } } }),
      prisma.operationalEvent.count({ where: { type: 'case.delivered', occurredAt: { gte: dayStart } } }),
      prisma.operationalCase.count({ where: { ...openCases, lastActivityAt: { lt: new Date(now.getTime() - 24 * HOUR) } } }),
      prisma.workItem.groupBy({ by: ['areaKey'], where: openWork, _count: { _all: true } }),
      prisma.workItem.groupBy({ by: ['areaKey'], where: { ...openWork, dueAt: { lt: now } }, _count: { _all: true } }),
      prisma.areaRequest.groupBy({ by: ['toAreaKey'], where: openRequests, _count: { _all: true } }),
      prisma.areaRequest.groupBy({ by: ['toAreaKey'], where: { ...openRequests, dueAt: { lt: now } }, _count: { _all: true } }),
      prisma.areaRequest.count({ where: { ...openRequests, blocksDelivery: true } }),
      prisma.incident.groupBy({ by: ['severity'], where: { status: { in: [...INCIDENT_OPEN_STATUSES] } }, _count: { _all: true } }),
      prisma.approvalRequest.count({ where: { status: 'pending' } }),
    ]);
    let aiByArea: PulseInput['aiByArea'] = null;
    try {
      const { getAreaAiUsage } = await import('@/modules/agents/budget');
      const day = localDayKey(now);
      const usage = await getAreaAiUsage({ from: day, to: day });
      aiByArea = usage.areas.map((row) => ({ areaKey: row.areaKey, tokens: row.tokens, usd: row.usd }));
    } catch {
      aiByArea = null;
    }
    return buildCompanyPulse({
      now,
      casesByStatus: countRows(byStatus, 'status').map((r) => ({ status: r.key, count: r.count })),
      casesByPhase: countRows(byPhase, 'phase').map((r) => ({ phase: r.key, count: r.count })),
      openedToday,
      deliveredToday,
      stuck24h,
      workOpenByArea: countRows(workOpen, 'areaKey').map((r) => ({ areaKey: r.key, count: r.count })),
      workOverdueByArea: countRows(workOverdue, 'areaKey').map((r) => ({ areaKey: r.key, count: r.count })),
      requestsOpenByArea: countRows(requestsOpen, 'toAreaKey').map((r) => ({ areaKey: r.key, count: r.count })),
      requestsOverdueByArea: countRows(requestsOverdue, 'toAreaKey').map((r) => ({ areaKey: r.key, count: r.count })),
      blockingRequests,
      incidentsBySeverity: countRows(incidents, 'severity').map((r) => ({ severity: r.key, count: r.count })),
      pendingApprovals,
      aiByArea,
    });
  },
});

registerOperationsTool({
  name: 'findStuckCases',
  description:
    'Expedientes abiertos y aún no entregados sin movimiento en las últimas N horas (24 por omisión), con lo que tienen pendiente, a quién esperan y qué conviene hacer.',
  requiredPermission: 'operations.admin',
  allowActor: isAdministratorBot,
  effect: 'read',
  parameters: z.object({
    idleHours: z.number().int().min(1).max(720).describe('Horas sin movimiento').default(24),
    limit: z.number().int().min(1).max(50).describe('Máximo de expedientes').default(20),
  }),
  execute: async (_actor, raw) => {
    const args = raw as { idleHours: number; limit: number };
    const now = new Date();
    const cases = await prisma.operationalCase.findMany({
      where: {
        status: { in: CASE_OPEN_STATUSES.filter((s) => s !== 'ready_to_close') },
        phase: { not: 'closing' },
        lastActivityAt: { lt: new Date(now.getTime() - args.idleHours * HOUR) },
      },
      orderBy: { lastActivityAt: 'asc' },
      take: args.limit,
      select: {
        id: true,
        caseNumber: true,
        salesOrderNumber: true,
        customerName: true,
        status: true,
        phase: true,
        ownerUserId: true,
        lastActivityAt: true,
        promisedAt: true,
      },
    });
    if (cases.length === 0) return { idleHours: args.idleHours, count: 0, cases: [] };
    const ids = cases.map((c) => c.id);
    const [workItems, activeSteps, requests] = await Promise.all([
      prisma.workItem.findMany({
        where: { caseId: { in: ids }, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
        select: { caseId: true, ownerUserId: true, dueAt: true, areaKey: true },
      }),
      prisma.caseStep.findMany({
        where: { caseId: { in: ids }, status: { in: ['active', 'waiting'] } },
        select: { caseId: true },
      }),
      prisma.areaRequest.findMany({
        where: { caseId: { in: ids }, status: { in: [...AREA_REQUEST_OPEN_STATUSES] } },
        select: { caseId: true, toAreaKey: true, blocksDelivery: true, status: true, dueAt: true },
      }),
    ]);
    const { isOrphanCase } = await import('@/modules/operations/supervisor-rules');
    const names = await userNames([...cases.map((c) => c.ownerUserId), ...workItems.map((w) => w.ownerUserId)]);
    return {
      idleHours: args.idleHours,
      count: cases.length,
      cases: cases.map((c) => {
        const items = workItems.filter((w) => w.caseId === c.id);
        const steps = activeSteps.filter((s) => s.caseId === c.id).length;
        return classifyStuckCase(
          {
            ...c,
            ownerName: names.get(c.ownerUserId) ?? null,
            orphan: isOrphanCase({ status: c.status, openWorkItems: items.length, activeSteps: steps, lastActivityAt: c.lastActivityAt }, now),
            openWorkItems: items.map((w) => ({ ownerName: names.get(w.ownerUserId) ?? null, dueAt: w.dueAt, areaKey: w.areaKey })),
            openRequests: requests.filter((r) => r.caseId === c.id),
          },
          now
        );
      }),
    };
  },
});

registerOperationsTool({
  name: 'whoIsBlocking',
  description:
    'Quién está deteniendo el trabajo: personas con trabajos vencidos o solicitudes vencidas/bloqueadas, con sus áreas, expedientes y el atraso más antiguo. Con caseId se limita a ese expediente.',
  requiredPermission: 'operations.admin',
  allowActor: isAdministratorBot,
  effect: 'read',
  parameters: z.object({
    caseId: z.string().trim().min(1).max(120).describe('Expediente (id, EXP-… u OV-…); por omisión toda la empresa').optional(),
    limit: z.number().int().min(1).max(30).describe('Máximo de personas').default(10),
  }),
  execute: async (_actor, raw) => {
    const args = raw as { caseId?: string; limit: number };
    const now = new Date();
    const ref = args.caseId ? await resolveCase(args.caseId) : null;
    const scope = ref ? { caseId: ref.id } : {};
    const [items, requests] = await Promise.all([
      prisma.workItem.findMany({
        where: { ...scope, status: { in: [...WORK_ITEM_OPEN_STATUSES] }, dueAt: { lt: now } },
        select: { id: true, caseId: true, areaKey: true, ownerUserId: true, title: true, dueAt: true, escalationLevel: true },
        orderBy: { dueAt: 'asc' },
        take: 500,
      }),
      prisma.areaRequest.findMany({
        where: {
          ...scope,
          status: { in: [...AREA_REQUEST_OPEN_STATUSES] },
          OR: [{ dueAt: { lt: now } }, { status: 'blocked' }, ...(ref ? [{ blocksDelivery: true }] : [])],
        },
        select: { id: true, caseId: true, toAreaKey: true, ownerUserId: true, title: true, dueAt: true, status: true, blocksDelivery: true },
        orderBy: { dueAt: 'asc' },
        take: 500,
      }),
    ]);
    const caseIds = [...new Set([...items.map((i) => i.caseId), ...requests.map((r) => r.caseId)].filter((id): id is string => Boolean(id)))];
    const [names, cases] = await Promise.all([
      userNames([...items.map((i) => i.ownerUserId), ...requests.map((r) => r.ownerUserId)]),
      caseIds.length
        ? prisma.operationalCase.findMany({ where: { id: { in: caseIds } }, select: { id: true, caseNumber: true } })
        : Promise.resolve([]),
    ]);
    const blockers = rankBlockers({ items, requests, now, names, caseNumbers: new Map(cases.map((c) => [c.id, c.caseNumber])) });
    return {
      scope: ref ? ref.caseNumber : 'empresa',
      totals: { overdueWorkItems: items.length, blockingRequests: requests.length, people: blockers.length },
      blockers: blockers.slice(0, args.limit),
    };
  },
});

registerOperationsTool({
  name: 'simulateDelay',
  description: `Simula qué pasa si un paso del proceso se retrasa N minutos: qué pasos se recorren, cuánto se mueve el cierre y si rebasa la promesa al cliente. Con caseId usa los pasos reales del expediente; sin él, la plantilla del proceso (pasos: ${SALES_FULFILLMENT_BLUEPRINT.steps.map((s) => s.key).join(', ')}).`,
  requiredPermission: 'operations.admin',
  allowActor: isAdministratorBot,
  effect: 'read',
  parameters: z.object({
    stepKey: z.string().trim().min(1).max(80).describe('Clave del paso que se retrasa'),
    delayMinutes: z.number().int().min(1).max(43_200).describe('Minutos de retraso (1 a 30 días)'),
    caseId: z.string().trim().min(1).max(120).describe('Expediente (id, EXP-… u OV-…)').optional(),
    scopeKey: z.string().trim().max(160).describe('Instancia del paso (partida o asignación); por omisión todas').optional(),
  }),
  execute: async (_actor, raw) => {
    const args = raw as { stepKey: string; delayMinutes: number; caseId?: string; scopeKey?: string };
    const now = new Date();
    if (!args.caseId) {
      return {
        mode: 'template',
        ...simulateStepDelay(blueprintSimulationSteps(), { stepKey: args.stepKey, delayMinutes: args.delayMinutes, now, start: now }),
      };
    }
    const ref = await resolveCase(args.caseId);
    const [opCase, rows] = await Promise.all([
      prisma.operationalCase.findUnique({ where: { id: ref.id }, select: { openedAt: true, processVersionId: true } }),
      prisma.caseStep.findMany({
        where: { caseId: ref.id },
        select: { stepKey: true, scopeKey: true, areaKey: true, dependsOn: true, slaMinutes: true, status: true, dueAt: true, completedAt: true },
      }),
    ]);
    if (!opCase || rows.length === 0) throw new OperationsToolError('El expediente no tiene pasos que simular', 'not_found');
    let labels = new Map(SALES_FULFILLMENT_BLUEPRINT.steps.map((s) => [s.key, s.label]));
    try {
      const { loadProcessBlueprint } = await import('@/modules/operations/process-blueprints/registry');
      const loaded = await loadProcessBlueprint(prisma, opCase.processVersionId);
      labels = new Map(loaded.blueprint.steps.map((s) => [s.key, s.label]));
    } catch {
      // keep the labels of the current blueprint
    }
    const steps: SimulationStep[] = rows.map((row) => ({
      ref: `${row.stepKey}:${row.scopeKey}`,
      stepKey: row.stepKey,
      scopeKey: row.scopeKey,
      label: labels.get(row.stepKey) ?? row.stepKey,
      areaKey: row.areaKey,
      dependsOn: row.dependsOn,
      slaMinutes: row.slaMinutes,
      status: row.status,
      dueAt: row.dueAt,
      completedAt: row.completedAt,
    }));
    return {
      mode: 'case',
      caseId: ref.id,
      caseNumber: ref.caseNumber,
      ...simulateStepDelay(steps, {
        stepKey: args.stepKey,
        scopeKey: args.scopeKey ?? null,
        delayMinutes: args.delayMinutes,
        now,
        start: opCase.openedAt,
        promisedAt: ref.promisedAt,
      }),
    };
  },
});
