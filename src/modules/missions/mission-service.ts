import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { publishRealtime } from '@/modules/realtime/realtime-service';

/**
 * Mission engine — persistent objectives the agent pursues until done.
 *
 * A mission runs as internal assistant turns (`⟦mission:{id}⟧`) inside its own
 * AiConversation, so every step gets the full pipeline: tools, verification,
 * memory write, approvals. The journal (MissionEvent) is append-only and also
 * feeds the realtime channel `mission:{id}` — the UI activity feed.
 *
 * Routines are missions with `schedule` ("daily:20:00" | "every:90" minutes):
 * each due run executes the goal fresh and journals the outcome.
 */

export const MISSION_PREFIX = '⟦mission:';
const MAX_STEPS_PER_MISSION = 60;
const MAX_JOURNAL_EVENTS = 2000;
const MAX_EVENTS_PER_TICK = 30;

export interface MissionStep {
  title: string;
  status: 'pending' | 'running' | 'awaiting_approval' | 'done' | 'failed' | 'skipped';
  toolHint?: string;
  result?: string;
  proposalId?: string;
}

export type MissionPlan = { steps: MissionStep[] };

export function missionChannel(missionId: string): string {
  return `mission:${missionId}`;
}

// ---------------------------------------------------------------------------
// Schedule spec — no cron dependency: "daily:HH:mm" (Mexico City) | "every:N" (minutes)
// ---------------------------------------------------------------------------

export function nextRunFrom(schedule: string | null | undefined, from: Date = new Date()): Date | null {
  if (!schedule) return null;
  const daily = /^daily:(\d{1,2}):(\d{2})$/.exec(schedule.trim());
  if (daily) {
    const hh = Math.min(23, Number(daily[1]));
    const mm = Math.min(59, Number(daily[2]));
    // Mexico City wall time → UTC Date.
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Mexico_City',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const parts = Object.fromEntries(fmt.formatToParts(from).map((p) => [p.type, p.value]));
    const targetMinutes = hh * 60 + mm;
    const nowMinutes = Number(parts.hour) * 60 + Number(parts.minute);
    const addDays = nowMinutes >= targetMinutes ? 1 : 0;
    const cd = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + addDays));
    const cdStr = cd.toISOString().slice(0, 10);
    // Convert "CD YYYY-MM-DD HH:mm Mexico City" to UTC via the zone offset trick.
    const guessUtc = new Date(`${cdStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
    const mxNow = new Date(guessUtc.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
    const utcNow = new Date(guessUtc.toLocaleString('en-US', { timeZone: 'UTC' }));
    const offsetMs = utcNow.getTime() - mxNow.getTime();
    return new Date(guessUtc.getTime() + offsetMs);
  }
  const every = /^every:(\d{1,5})$/.exec(schedule.trim());
  if (every) {
    const minutes = Math.max(5, Math.min(10080, Number(every[1]))); // 5 min … 7 days
    return new Date(from.getTime() + minutes * 60_000);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Journal + realtime
// ---------------------------------------------------------------------------

export async function journal(missionId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await prisma.missionEvent.create({
    data: { missionId, type, payload: payload as Prisma.InputJsonValue },
  });
  void publishRealtime(missionChannel(missionId), type, payload).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface MissionInput {
  goal: string;
  steps?: string[];
  schedule?: string | null;
  budgetUsd?: number | null;
  conversationId?: string | null;
}

export async function proposeMission(actor: CurrentUser, input: MissionInput): Promise<{ id: string; status: string }> {
  const steps: MissionStep[] = (input.steps ?? [])
    .slice(0, 24)
    .map((title) => ({ title: String(title).slice(0, 200), status: 'pending' as const }));
  const mission = await prisma.mission.create({
    data: {
      userId: actor.id,
      conversationId: input.conversationId ?? null,
      goal: input.goal.slice(0, 500),
      status: 'awaiting_approval',
      plan: { steps } as unknown as Prisma.InputJsonValue,
      budgetUsd: input.budgetUsd ?? null,
      schedule: input.schedule ?? null,
    },
  });
  await journal(mission.id, 'note', { text: `Misión propuesta: ${mission.goal}`, steps: steps.length });
  return { id: mission.id, status: mission.status };
}

export async function approveMission(userId: string, missionId: string): Promise<boolean> {
  const mission = await prisma.mission.findFirst({ where: { id: missionId, userId } });
  if (!mission || mission.status !== 'awaiting_approval') return false;
  const nextRunAt = mission.schedule ? nextRunFrom(mission.schedule) : new Date();
  await prisma.mission.update({
    where: { id: missionId },
    data: { status: 'active', nextRunAt },
  });
  await journal(missionId, 'note', { text: 'Misión aprobada — el agente empieza a trabajar.' });
  return true;
}

export async function setMissionStatus(
  userId: string,
  missionId: string,
  status: 'cancelled' | 'blocked' | 'active'
): Promise<boolean> {
  const mission = await prisma.mission.findFirst({ where: { id: missionId, userId } });
  if (!mission || ['done', 'failed', 'cancelled'].includes(mission.status)) return false;
  await prisma.mission.update({
    where: { id: missionId },
    data: { status, ...(status === 'active' && mission.schedule ? { nextRunAt: nextRunFrom(mission.schedule) } : {}) },
  });
  await journal(missionId, 'note', { text: `Misión → ${status}` });
  return true;
}

export async function listMissions(userId: string, opts: { status?: string; limit?: number } = {}) {
  const rows = await prisma.mission.findMany({
    where: { userId, ...(opts.status ? { status: opts.status } : { status: { notIn: ['cancelled'] } }) },
    orderBy: { updatedAt: 'desc' },
    take: Math.min(opts.limit ?? 20, 50),
    select: {
      id: true, goal: true, status: true, plan: true, schedule: true,
      nextRunAt: true, createdAt: true, completedAt: true, conversationId: true,
    },
  });
  return rows.map((m) => ({
    ...m,
    plan: m.plan as MissionPlan | null,
  }));
}

export async function getMissionWithEvents(userId: string, missionId: string) {
  const mission = await prisma.mission.findFirst({ where: { id: missionId, userId } });
  if (!mission) return null;
  const events = await prisma.missionEvent.findMany({
    where: { missionId },
    orderBy: { createdAt: 'asc' },
    take: MAX_JOURNAL_EVENTS,
  });
  return { mission: { ...mission, plan: mission.plan as MissionPlan | null }, events };
}

// ---------------------------------------------------------------------------
// Execution — one step per tick, full assistant pipeline per step
// ---------------------------------------------------------------------------

async function ensureMissionConversation(mission: { id: string; userId: string; conversationId: string | null; goal: string }): Promise<string> {
  if (mission.conversationId) return mission.conversationId;
  const { createConversation } = await import('@/modules/ai/ai-sessions-service');
  const conv = await createConversation(mission.userId, { kind: 'mission', missionId: mission.id });
  await prisma.mission.update({ where: { id: mission.id }, data: { conversationId: conv.id } });
  return conv.id;
}

function missionPlan(mission: { plan: unknown }): MissionPlan {
  const plan = mission.plan as MissionPlan | null;
  return plan && Array.isArray(plan.steps) ? plan : { steps: [] };
}

async function savePlan(missionId: string, plan: MissionPlan): Promise<void> {
  await prisma.mission.update({ where: { id: missionId }, data: { plan: plan as unknown as Prisma.InputJsonValue } });
}

/**
 * Resolves steps waiting on a proposal. Returns the index of the next runnable
 * step, or null when nothing can advance this tick.
 */
async function reconcileSteps(missionId: string, plan: MissionPlan): Promise<number | null> {
  let dirty = false;
  for (const step of plan.steps) {
    if (step.status !== 'awaiting_approval' || !step.proposalId) continue;
    const proposal = await prisma.aiProposal.findUnique({
      where: { id: step.proposalId },
      select: { status: true },
    });
    if (!proposal) continue;
    if (proposal.status === 'executed') {
      step.status = 'done';
      step.result = 'Acción aprobada y ejecutada por el usuario.';
      dirty = true;
      await journal(missionId, 'step_done', { title: step.title, via: 'approval' });
    } else if (['rejected', 'failed', 'expired', 'invalidated'].includes(proposal.status)) {
      step.status = 'failed';
      step.result = `La propuesta quedó ${proposal.status}.`;
      dirty = true;
      await journal(missionId, 'error', { title: step.title, reason: `propuesta ${proposal.status}` });
    }
    // still pending → leave as is; tick skips it below
  }
  if (dirty) await savePlan(missionId, plan);
  const next = plan.steps.findIndex((s) => s.status === 'pending');
  return next >= 0 ? next : null;
}

/**
 * Runs ONE mission step as an internal assistant turn. The model gets the goal,
 * the current step and the recent journal; it uses tools, creates proposals
 * (pausing the step until approved) and writes memory as usual.
 */
export async function runMissionStep(missionId: string): Promise<{ advanced: boolean; done: boolean }> {
  const mission = await prisma.mission.findUnique({ where: { id: missionId } });
  if (!mission || mission.status !== 'active') return { advanced: false, done: mission?.status === 'done' };

  const { loadUserActor } = await import('@/modules/auth/user-actor');
  const actor = await loadUserActor({ id: mission.userId });
  if (!actor) return { advanced: false, done: false };

  const plan = missionPlan(mission);
  const nextIdx = await reconcileSteps(missionId, plan);

  // Routine without steps: every run executes the goal directly.
  const routine = Boolean(mission.schedule) && plan.steps.length === 0;
  if (!routine && nextIdx === null) {
    const anyAwaiting = plan.steps.some((s) => s.status === 'awaiting_approval');
    if (!anyAwaiting) {
      await completeMission(mission.id);
      return { advanced: false, done: true };
    }
    return { advanced: false, done: false };
  }

  const step = routine ? null : plan.steps[nextIdx!];
  if (step) {
    step.status = 'running';
    await savePlan(missionId, plan);
  }

  // Recent journal → compact context for the step turn.
  const recent = await prisma.missionEvent.findMany({
    where: { missionId },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: { type: true, payload: true, createdAt: true },
  });
  const journalDigest = recent
    .reverse()
    .map((e) => `- ${e.type}: ${JSON.stringify(e.payload).slice(0, 200)}`)
    .join('\n');

  const conversationId = await ensureMissionConversation(mission);
  const totalSteps = plan.steps.length;
  const message =
    `${MISSION_PREFIX}${mission.id}⟧ ` +
    (routine
      ? `Ejecuta la rutina: ${mission.goal}`
      : `Paso ${nextIdx! + 1}/${totalSteps}: ${step!.title}`) +
    `\n\nOBJETIVO DE LA MISIÓN: ${mission.goal}` +
    (journalDigest ? `\n\nÚLTIMOS EVENTOS:\n${journalDigest}` : '') +
    '\n\nInstrucciones: ejecuta SOLO este paso usando las tools necesarias. ' +
    'Si un efecto externo requiere aprobación, propón la acción — la misión espera la aprobación. ' +
    'Termina con un resumen de una línea del resultado del paso.';

  await journal(missionId, 'step_started', {
    title: step?.title ?? mission.goal,
    step: routine ? null : nextIdx! + 1,
    total: totalSteps || null,
  });

  const { runAssistant } = await import('@/modules/ai/ai-orchestrator');
  let answer = '';
  let proposalPending: { id: string; summary: string } | null = null;
  let turnError: string | null = null;
  let events = 0;

  try {
    for await (const event of runAssistant({
      conversationId,
      actor,
      message,
      context: { page: 'assistant' },
    })) {
      if (++events > MAX_EVENTS_PER_TICK * 4) break;
      const d = (event.data ?? {}) as Record<string, unknown>;
      if (event.type === 'token' && typeof d.delta === 'string') {
        answer += d.delta;
      } else if (event.type === 'done' && typeof d.content === 'string') {
        answer = d.content;
      } else if (event.type === 'proposal' && d.id) {
        proposalPending = {
          id: String(d.id),
          summary: String(d.summary ?? 'acción propuesta'),
        };
      } else if (event.type === 'tool_call_end' && d.name) {
        if (events <= MAX_EVENTS_PER_TICK) {
          await journal(missionId, 'tool_call', {
            tool: d.name,
            success: Boolean(d.success),
            needsApproval: Boolean(d.needsApproval),
          });
        }
      } else if (event.type === 'error') {
        turnError = String(d.message ?? 'error');
      }
    }
  } catch (err) {
    turnError = err instanceof Error ? err.message : String(err);
  }

  const summary = answer.replace(/\s+/g, ' ').trim().slice(0, 300) || turnError || 'sin resultado';

  if (proposalPending && step) {
    step.status = 'awaiting_approval';
    step.proposalId = proposalPending.id;
    step.result = `Esperando aprobación: ${proposalPending.summary}`;
    await savePlan(missionId, plan);
    await journal(missionId, 'approval', { step: step.title, proposalId: proposalPending.id, summary: proposalPending.summary });
    return { advanced: true, done: false };
  }

  if (turnError) {
    if (step) {
      step.status = 'failed';
      step.result = summary;
      await savePlan(missionId, plan);
    }
    await journal(missionId, 'error', { title: step?.title ?? mission.goal, reason: summary });
    await prisma.mission.update({ where: { id: missionId }, data: { status: 'blocked' } });
    return { advanced: true, done: false };
  }

  if (step) {
    step.status = 'done';
    step.result = summary;
    await savePlan(missionId, plan);
    await journal(missionId, 'step_done', { title: step.title, result: summary });
  } else {
    await journal(missionId, 'finding', { run: 'routine', result: summary });
  }

  // One-shot mission with all steps done → complete. Routine → schedule next run.
  const allDone = routine ? false : plan.steps.every((s) => s.status === 'done' || s.status === 'skipped');
  if (allDone) {
    await completeMission(missionId);
    return { advanced: true, done: true };
  }
  if (mission.schedule) {
    await prisma.mission.update({
      where: { id: missionId },
      data: { nextRunAt: nextRunFrom(mission.schedule) },
    });
  }
  return { advanced: true, done: false };
}

async function completeMission(missionId: string): Promise<void> {
  const mission = await prisma.mission.findUnique({ where: { id: missionId }, select: { userId: true, goal: true, plan: true } });
  await prisma.mission.update({
    where: { id: missionId },
    data: { status: 'done', completedAt: new Date(), nextRunAt: null },
  });
  await journal(missionId, 'note', { text: `Misión completada: ${mission?.goal ?? ''}` });
  await prisma.notification
    .create({
      data: {
        userId: mission!.userId,
        type: 'mission',
        category: 'system',
        title: 'Misión completada',
        body: (mission?.goal ?? '').slice(0, 200),
        entityType: 'mission',
        entityId: missionId,
        url: '/app/assistant',
      },
    })
    .catch(() => undefined);
}

/**
 * Tick handler: runs one step of every due mission (bounded). One-shot missions
 * advance a step per tick; routines run when nextRunAt passes.
 */
export async function tickMissions(now: Date = new Date()): Promise<{ ran: number }> {
  const due = await prisma.mission.findMany({
    where: {
      status: 'active',
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
    orderBy: { updatedAt: 'asc' },
    take: 5,
    select: { id: true, plan: true },
  });
  let ran = 0;
  for (const m of due) {
    // Guard against runaway plans.
    const plan = missionPlan(m);
    if (plan.steps.length > MAX_STEPS_PER_MISSION) {
      await prisma.mission.update({ where: { id: m.id }, data: { status: 'failed' } });
      await journal(m.id, 'error', { reason: 'plan demasiado largo' });
      continue;
    }
    try {
      const res = await runMissionStep(m.id);
      if (res.advanced) ran++;
      // Active one-shot missions without schedule: keep them due for the next tick.
      const fresh = await prisma.mission.findUnique({ where: { id: m.id }, select: { status: true, schedule: true } });
      if (fresh?.status === 'active' && fresh.schedule && res.advanced) {
        await prisma.mission.update({ where: { id: m.id }, data: { nextRunAt: nextRunFrom(fresh.schedule) } });
      }
    } catch (err) {
      console.error(JSON.stringify({ event: 'mission.step_error', missionId: m.id, error: err instanceof Error ? err.message : String(err) }));
    }
  }
  return { ran };
}
