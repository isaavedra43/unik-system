import { prisma } from '@/lib/prisma';
import { enqueueJob, registerJobHandler } from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import { publishRealtime } from '@/modules/realtime/realtime-service';
import { executeTool } from '@/modules/ai/tools/registry';
import type { CurrentUser } from '@/modules/auth/authorization';
import { DEFAULT_TENANT_ID } from './tenancy';

/**
 * Triggers UNIVERSO (B9) — trabajo always-on que NO depende de que el usuario
 * esté despierto. Cada disparo corre en sesión fresca (conversación nueva),
 * nunca hereda el hilo del chat.
 *
 * Tipos (spec.action = {kind:'run'|'mission', goal, capsule?}):
 * - `time`: {everyMinutes} | {atHour, atMinute, tz} — rutinas/briefings.
 * - `condition`: {tool, args, threshold, path} — sonda DETERMINISTA sin LLM:
 *   ejecuta una tool read-only whitelisted; si supera el umbral → dispara el
 *   run (Jev decide dentro del turno si amerita agente pesado).
 * - `entity_change`/`event`/`webhook`/`message`: disparados por
 *   `fireTriggersForEvent(entity, payload)` desde otros módulos.
 */

const CONDITION_PROBE_TOOLS = new Set([
  'listSalesOrders', 'getSalesOrder', 'listInvoices', 'listQuotes',
  'getInventoryStatus', 'listProducts', 'listCustomers', 'searchRecords',
]);

export interface TriggerSpec {
  everyMinutes?: number;
  atHour?: number;
  atMinute?: number;
  tz?: string;
  entity?: string;
  tool?: string;
  args?: Record<string, unknown>;
  threshold?: number;
  path?: string;
  secret?: string;
}

export interface TriggerAction {
  /** run = turno del agente · mission = misión propuesta · playbook = VenuePlaybook determinista */
  kind: 'run' | 'mission' | 'playbook';
  goal: string;
  capsule?: string;
  /** kind='playbook': id del VenuePlaybook aprobado a ejecutar. */
  playbookId?: string;
}

/** Próxima corrida de un trigger `time` (mínimo viable, sin dependencias). */
export function computeNextRun(spec: TriggerSpec, from = new Date()): Date | null {
  if (spec.everyMinutes && spec.everyMinutes >= 1) {
    return new Date(from.getTime() + spec.everyMinutes * 60_000);
  }
  if (spec.atHour !== undefined) {
    const next = new Date(from);
    next.setHours(spec.atHour, spec.atMinute ?? 0, 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  return null;
}

export async function createTrigger(input: {
  tenantId?: string;
  agentId: string;
  type: string;
  spec: TriggerSpec;
  action: TriggerAction;
}): Promise<{ id: string } | { error: string }> {
  try {
    const t = await prisma.trigger.create({
      data: {
        tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
        agentId: input.agentId,
        type: input.type,
        spec: input.spec as never,
        action: input.action as never,
        nextRunAt: input.type === 'time' ? computeNextRun(input.spec) ?? undefined : undefined,
      },
    });
    return { id: t.id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'No se pudo crear' };
  }
}

export async function listTriggers(tenantId: string, agentId?: string) {
  return prisma.trigger.findMany({
    where: { tenantId, ...(agentId ? { agentId } : {}), enabled: true },
    orderBy: { createdAt: 'desc' },
  }).catch(() => []);
}

/** Dispara un trigger → job `agent.trigger.fire` (sesión fresca por diseño). */
async function fireTrigger(triggerId: string, reason: string): Promise<void> {
  await enqueueJob({
    type: 'agent.trigger.fire',
    payload: { triggerId, reason },
    dedupeKey: `trigger:${triggerId}:${Math.floor(Date.now() / 60_000)}`,
  }).catch(() => null);
}

/** Sonda determinista para triggers `condition` — cero LLM. */
async function evalCondition(spec: TriggerSpec, actor: CurrentUser): Promise<boolean> {
  if (!spec.tool || !CONDITION_PROBE_TOOLS.has(spec.tool)) return false;
  const res = await executeTool(spec.tool, actor, spec.args ?? {}, { skipCache: true });
  if (!res.success) return false;
  const path = spec.path ?? 'count';
  const value = (res.result as Record<string, unknown> | undefined)?.[path];
  const num = typeof value === 'number' ? value : Array.isArray(value) ? value.length : 0;
  return num >= (spec.threshold ?? 1);
}

/** trigger.tick — corre cada minuto junto a mission.tick. */
async function tickTriggers(): Promise<{ fired: number }> {
  let fired = 0;
  const due = await prisma.trigger.findMany({
    where: { enabled: true, type: 'time', nextRunAt: { lte: new Date() } },
    take: 50,
  }).catch(() => [] as never[]);
  for (const t of due as Array<{ id: string; spec: unknown }>) {
    const spec = (t.spec ?? {}) as TriggerSpec;
    await prisma.trigger.update({
      where: { id: t.id },
      data: { lastFiredAt: new Date(), nextRunAt: computeNextRun(spec) },
    }).catch(() => null);
    await fireTrigger(t.id, 'time');
    fired += 1;
  }

  // Conditions: sondas read-only deterministas, cada trigger evalúa la suya.
  const conditions = await prisma.trigger.findMany({
    where: { enabled: true, type: 'condition' },
    take: 50,
  }).catch(() => [] as never[]);
  for (const t of conditions as Array<{ id: string; spec: unknown; agentId: string; tenantId: string }>) {
    const spec = (t.spec ?? {}) as TriggerSpec;
    const agent = await prisma.agent.findUnique({ where: { id: t.agentId } }).catch(() => null);
    if (!agent) continue;
    const { loadUserActor } = await import('@/modules/auth/user-actor');
    const actor = await loadUserActor({ id: agent.ownerUserId }).catch(() => null);
    if (!actor) continue;
    if (await evalCondition(spec, actor).catch(() => false)) {
      await fireTrigger(t.id, 'condition-met');
      fired += 1;
    }
  }
  return { fired };
}

/** Dispara triggers por evento (entity_change, webhook, message, manual). */
export async function fireTriggersForEvent(type: string, match: Record<string, unknown>): Promise<number> {
  const triggers = await prisma.trigger.findMany({
    where: { enabled: true, type },
  }).catch(() => [] as never[]);
  let fired = 0;
  for (const t of triggers as Array<{ id: string; spec: unknown }>) {
    const spec = (t.spec ?? {}) as TriggerSpec;
    if (spec.entity && match.entity && spec.entity !== match.entity) continue;
    await fireTrigger(t.id, type);
    fired += 1;
  }
  return fired;
}

/** Job `agent.trigger.fire` — ejecuta la acción en sesión fresca. */
async function fireTriggerNow(triggerId: string): Promise<{ status: string }> {
  const t = await prisma.trigger.findUnique({ where: { id: triggerId } }).catch(() => null);
  if (!t || !t.enabled) return { status: 'disabled' };
  const action = (t.action ?? {}) as unknown as TriggerAction;
  const agent = await prisma.agent.findUnique({ where: { id: t.agentId } }).catch(() => null);
  if (!agent || agent.status !== 'active') return { status: 'agent-inactive' };

  const { loadUserActor } = await import('@/modules/auth/user-actor');
  const actor = await loadUserActor({ id: agent.ownerUserId }).catch(() => null);
  if (!actor) return { status: 'no-actor' };

  if (action.kind === 'mission') {
    const { proposeMission } = await import('@/modules/missions/mission-service');
    await proposeMission(actor, { goal: action.goal }).catch(() => null);
    return { status: 'mission-created' };
  }

  // kind='playbook' (B11): corre el VenuePlaybook directo — determinista, sin
  // LLM. "Guardar como rutina" convierte una automatización exitosa en
  // trabajo programado real.
  if (action.kind === 'playbook' && action.playbookId) {
    const res = await executeTool('runVenuePlaybook', actor, { playbookId: action.playbookId }, {
      agentId: agent.id,
    }).catch(() => null);
    const ok = Boolean(res?.success);
    await publishRealtime(`user:${agent.ownerUserId}`, 'agent.trigger', {
      triggerId: t.id, agentId: agent.id, agentName: agent.name,
      preview: ok ? `Playbook ejecutado: ${action.goal}` : `Playbook falló: ${action.goal}`,
    }).catch(() => null);
    return { status: ok ? 'playbook-done' : 'playbook-failed' };
  }

  // kind='run' → sesión fresca del agente.
  const convo = await prisma.aiConversation.create({
    data: { userId: agent.ownerUserId, agentId: agent.id, title: `⏱ ${action.goal}`.slice(0, 120) },
  }).catch(() => null);

  const { executeAgentTurn } = await import('./agent-runtime');
  let report = '';
  for await (const ev of executeAgentTurn({
    conversationId: convo?.id ?? `trigger-${t.id}`,
    message: `${action.capsule ? `${action.capsule}\n\n` : ''}${action.goal}`,
    actor,
    agentId: agent.id,
  })) {
    if (ev.type === 'done' || ev.type === 'message_done') {
      const d = ev.data as { content?: string } | undefined;
      if (d?.content) report = d.content;
    }
  }

  // Si el run produjo algo, notifica al dueño (la rutina existe para avisar).
  if (report.trim()) {
    await publishRealtime(`user:${agent.ownerUserId}`, 'agent.trigger', {
      triggerId: t.id, agentId: agent.id, agentName: agent.name,
      conversationId: convo?.id ?? null,
      preview: report.slice(0, 300),
    }).catch(() => null);
  }
  return { status: report ? 'done' : 'empty' };
}

registerJobHandler('trigger.tick', async () => tickTriggers());
registerRecurringJob({ type: 'trigger.tick', everyMs: 60 * 1000 });

registerJobHandler('agent.trigger.fire', async (ctx) => {
  const { triggerId } = ctx.payload as { triggerId: string };
  return fireTriggerNow(triggerId);
});
