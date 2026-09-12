import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import {
  executeTool,
  getToolDefinition,
  type ToolExecutionResult,
} from '@/modules/ai/tools/registry';
import { evaluateCondition, resolveTemplates, TemplateError } from './skill-templates';
import {
  getRunnableSkill,
  skillDefinitionSchema,
  type SkillDefinition,
  type SkillStep,
} from './skills-service';
import { refreshExternalTools } from './external-tools';
import { redactDeep } from './secrets';

/**
 * Declarative skill runner.
 *
 * Executes steps in dependency order. Tool steps go through the COMMON
 * executor (permissions, enablement, effect classification, limits) and are
 * additionally restricted to the skill's `allowedTools`. When a step needs
 * user approval the run is persisted as `waiting_approval` and resumes after
 * the proposal is approved. Runs survive restarts because their state lives
 * in PostgreSQL.
 */

export interface SkillRunState {
  steps: Record<
    string,
    {
      status: 'done' | 'skipped' | 'failed' | 'waiting';
      result?: unknown;
      error?: string;
      proposalId?: string;
    }
  >;
  notes: string[];
  toolCalls: number;
  startedAt: string;
}

export class SkillRunError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'SkillRunError';
  }
}

function order(def: SkillDefinition): SkillStep[] {
  const done = new Set<string>();
  const out: SkillStep[] = [];
  const remaining = [...def.steps];
  while (remaining.length > 0) {
    const idx = remaining.findIndex((s) => s.dependsOn.every((d) => done.has(d)));
    if (idx < 0) throw new SkillRunError('Dependencias circulares en la skill', 400);
    const step = remaining.splice(idx, 1)[0];
    out.push(step);
    done.add(step.id);
  }
  return out;
}

function validateInputs(
  def: SkillDefinition,
  inputs: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const input of def.inputs) {
    const value = inputs[input.name];
    if (value === undefined || value === null || value === '') {
      if (input.required)
        throw new SkillRunError(`Falta la entrada requerida: ${input.label || input.name}`, 400);
      continue;
    }
    if (input.type === 'number' && typeof value !== 'number')
      throw new SkillRunError(`${input.name} debe ser numérico`, 400);
    if (input.type === 'boolean' && typeof value !== 'boolean')
      throw new SkillRunError(`${input.name} debe ser booleano`, 400);
    if (input.type === 'string' && typeof value !== 'string')
      throw new SkillRunError(`${input.name} debe ser texto`, 400);
    out[input.name] = value;
  }
  return out;
}

interface RunContext {
  inputs: Record<string, unknown>;
  steps: Record<string, { result?: unknown }>;
}

function buildData(state: SkillRunState, inputs: Record<string, unknown>): RunContext {
  const steps: Record<string, { result?: unknown }> = {};
  for (const [id, s] of Object.entries(state.steps)) steps[id] = { result: s.result };
  return { inputs, steps };
}

export interface SkillRunOutcome {
  runId: string;
  status: 'completed' | 'waiting_approval' | 'failed';
  notes: string[];
  results: Record<string, unknown>;
  proposal?: { id: string; summary: string; effect: string; expiresAt: string; toolName: string };
  error?: string;
  summary?: string;
}

async function persist(
  runId: string,
  state: SkillRunState,
  status: string,
  currentStep: string | null,
  extra: { proposalId?: string | null; error?: string | null } = {}
) {
  await prisma.skillRun.update({
    where: { id: runId },
    data: {
      state: redactDeep(state) as unknown as Prisma.InputJsonValue,
      status,
      currentStep,
      proposalId: extra.proposalId === undefined ? undefined : extra.proposalId,
      error: extra.error === undefined ? undefined : extra.error,
      completedAt: status === 'completed' || status === 'failed' ? new Date() : null,
    },
  });
}

/** Starts a new run of a skill the actor may use. */
export async function runSkillByKey(
  actor: CurrentUser,
  key: string,
  inputs: Record<string, unknown>,
  options: { conversationId?: string } = {}
): Promise<SkillRunOutcome> {
  const skill = await getRunnableSkill(actor, key);
  const parsed = skillDefinitionSchema.safeParse(skill.definition);
  if (!parsed.success) throw new SkillRunError('La definición de la skill es inválida', 500);
  const def = parsed.data;
  const validInputs = validateInputs(def, inputs);
  const state: SkillRunState = {
    steps: {},
    notes: [],
    toolCalls: 0,
    startedAt: new Date().toISOString(),
  };
  const run = await prisma.skillRun.create({
    data: {
      skillId: skill.id,
      skillVersion: skill.version,
      userId: actor.id,
      conversationId: options.conversationId ?? null,
      status: 'running',
      inputs: validInputs as Prisma.InputJsonValue,
      state: state as unknown as Prisma.InputJsonValue,
    },
  });
  return continueRun(actor, run.id, def, validInputs, state, options.conversationId);
}

/** Resumes a run waiting for approval once its proposal was decided. */
export async function resumeSkillRun(actor: CurrentUser, runId: string): Promise<SkillRunOutcome> {
  const run = await prisma.skillRun.findUnique({ where: { id: runId }, include: { skill: true } });
  if (!run || run.userId !== actor.id) throw new SkillRunError('Ejecución no encontrada', 404);
  if (run.status !== 'waiting_approval')
    throw new SkillRunError('La ejecución no está esperando aprobación', 409);
  const def = skillDefinitionSchema.parse(run.skill.definition);
  const state = run.state as unknown as SkillRunState;
  if (run.proposalId && run.currentStep) {
    const proposal = await prisma.aiProposal.findUnique({ where: { id: run.proposalId } });
    if (!proposal) throw new SkillRunError('Propuesta no encontrada', 404);
    if (proposal.status === 'executed') {
      state.steps[run.currentStep] = { status: 'done', result: proposal.result ?? null };
    } else if (proposal.status === 'pending' || proposal.status === 'approved') {
      return {
        runId,
        status: 'waiting_approval',
        notes: state.notes,
        results: collectResults(state),
        proposal: {
          id: proposal.id,
          summary: proposal.summary,
          effect: proposal.effect,
          expiresAt: proposal.expiresAt.toISOString(),
          toolName: proposal.toolName,
        },
      };
    } else {
      state.steps[run.currentStep] = { status: 'failed', error: `Propuesta ${proposal.status}` };
      await persist(runId, state, 'failed', run.currentStep, {
        error: `El paso ${run.currentStep} no fue aprobado (${proposal.status})`,
      });
      return {
        runId,
        status: 'failed',
        notes: state.notes,
        results: collectResults(state),
        error: `El paso ${run.currentStep} no fue aprobado`,
      };
    }
  }
  return continueRun(
    actor,
    runId,
    def,
    run.inputs as Record<string, unknown>,
    state,
    run.conversationId ?? undefined
  );
}

function collectResults(state: SkillRunState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(state.steps)) if (s.status === 'done') out[id] = s.result;
  return out;
}

async function continueRun(
  actor: CurrentUser,
  runId: string,
  def: SkillDefinition,
  inputs: Record<string, unknown>,
  state: SkillRunState,
  conversationId?: string
): Promise<SkillRunOutcome> {
  await refreshExternalTools();
  const deadline = new Date(state.startedAt).getTime() + def.limits.maxDurationMs;
  for (const step of order(def)) {
    if (state.steps[step.id]?.status === 'done' || state.steps[step.id]?.status === 'skipped')
      continue;
    if (Date.now() > deadline) {
      await persist(runId, state, 'failed', step.id, {
        error: 'Tiempo máximo de ejecución excedido',
      });
      return {
        runId,
        status: 'failed',
        notes: state.notes,
        results: collectResults(state),
        error: 'Tiempo máximo de ejecución excedido',
      };
    }
    const data = buildData(state, inputs);
    const failedDep = step.dependsOn.find((d) => state.steps[d]?.status === 'failed');
    if (failedDep) {
      state.steps[step.id] = { status: 'skipped', error: `Dependencia fallida: ${failedDep}` };
      continue;
    }
    try {
      if (step.type === 'check') {
        if (!evaluateCondition(step.condition, data)) {
          state.steps[step.id] = { status: 'failed', error: step.message };
          await persist(runId, state, 'failed', step.id, { error: step.message });
          return {
            runId,
            status: 'failed',
            notes: state.notes,
            results: collectResults(state),
            error: step.message,
          };
        }
        state.steps[step.id] = { status: 'done', result: true };
        continue;
      }
      if (step.type === 'note') {
        if (step.when && !evaluateCondition(step.when, data)) {
          state.steps[step.id] = { status: 'skipped' };
          continue;
        }
        const text = String(resolveTemplates(step.text, data));
        state.notes.push(text);
        state.steps[step.id] = { status: 'done', result: text };
        continue;
      }
      // tool step
      if (step.when && !evaluateCondition(step.when, data)) {
        state.steps[step.id] = { status: 'skipped' };
        continue;
      }
      if (!def.allowedTools.includes(step.tool)) {
        throw new SkillRunError(
          `La skill intenta usar una herramienta fuera de su lista: ${step.tool}`,
          403
        );
      }
      if (state.toolCalls >= def.limits.maxToolCalls) {
        throw new SkillRunError('La skill excedió su límite de llamadas a herramientas', 429);
      }
      if (!getToolDefinition(step.tool)) {
        throw new SkillRunError(`Herramienta no disponible: ${step.tool}`, 404);
      }
      const args = resolveTemplates(step.args, data);
      state.toolCalls++;
      const result: ToolExecutionResult = await executeTool(step.tool, actor, args, {
        conversationId,
        skillRunId: runId,
        // A skill step can demand approval even for read tools.
        ...(step.requireApproval ? { enabledToolNames: undefined } : {}),
      });
      if (result.needsApproval && result.proposal) {
        state.steps[step.id] = { status: 'waiting', proposalId: result.proposal.id };
        await persist(runId, state, 'waiting_approval', step.id, {
          proposalId: result.proposal.id,
        });
        return {
          runId,
          status: 'waiting_approval',
          notes: state.notes,
          results: collectResults(state),
          proposal: result.proposal,
        };
      }
      if (!result.success) {
        state.steps[step.id] = { status: 'failed', error: result.error ?? 'error' };
        await persist(runId, state, 'failed', step.id, { error: result.error ?? 'error' });
        return {
          runId,
          status: 'failed',
          notes: state.notes,
          results: collectResults(state),
          error: `El paso ${step.id} falló: ${result.error ?? 'error'}`,
        };
      }
      state.steps[step.id] = { status: 'done', result: result.result ?? null };
      await persist(runId, state, 'running', step.id);
    } catch (err) {
      const message =
        err instanceof TemplateError || err instanceof SkillRunError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Error';
      state.steps[step.id] = { status: 'failed', error: message };
      await persist(runId, state, 'failed', step.id, { error: message });
      return {
        runId,
        status: 'failed',
        notes: state.notes,
        results: collectResults(state),
        error: message,
      };
    }
  }

  const data = buildData(state, inputs);
  for (const condition of def.completion.conditions) {
    if (!evaluateCondition(condition, data)) {
      const message = `Condición de finalización no cumplida: ${condition.path} ${condition.op}`;
      await persist(runId, state, 'failed', null, { error: message });
      return {
        runId,
        status: 'failed',
        notes: state.notes,
        results: collectResults(state),
        error: message,
      };
    }
  }
  const summary = def.completion.summaryTemplate
    ? String(resolveTemplates(def.completion.summaryTemplate, data))
    : undefined;
  await persist(runId, state, 'completed', null, { proposalId: null, error: null });
  return {
    runId,
    status: 'completed',
    notes: state.notes,
    results: collectResults(state),
    summary,
  };
}

export async function listSkillRuns(
  actor: CurrentUser,
  options: { skillId?: string; limit?: number } = {}
) {
  const rows = await prisma.skillRun.findMany({
    where: { userId: actor.id, ...(options.skillId ? { skillId: options.skillId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(options.limit ?? 50, 200),
    include: { skill: { select: { key: true, name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    skill: r.skill,
    status: r.status,
    currentStep: r.currentStep,
    proposalId: r.proposalId,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
  }));
}
