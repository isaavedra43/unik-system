import { randomUUID } from 'crypto';
import { prisma } from '@/lib/prisma';
import { DEFAULT_TENANT_ID } from './tenancy';
import { ensurePrincipal } from './agent-service';

/**
 * AgentRun recorder — la envoltura de observabilidad del runtime (fase B0).
 *
 * Cada turno del asistente persiste un AgentRun con traceId + eventos
 * append-only en AgentEvent. Todo es fail-soft: si las tablas aún no existen
 * en producción, recording se desactiva silenciosamente y el chat funciona
 * exactamente igual.
 */

export interface RunHandle {
  runId: string;
  traceId: string;
  agentId: string;
}

let runsTableReady: boolean | null = null;

async function runsReady(): Promise<boolean> {
  if (runsTableReady === false) return false;
  try {
    await prisma.agentRun.findFirst({ select: { id: true } });
    runsTableReady = true;
    return true;
  } catch {
    runsTableReady = false;
    return false;
  }
}

export interface StartRunInput {
  userId: string;
  tenantId?: string;
  conversationId?: string | null;
  agentId?: string | null;
  /** 'chat' | 'mission' | 'task' | 'trigger' | 'voice' | 'mcp' */
  source?: string;
  parentRunId?: string | null;
  taskId?: string | null;
  missionId?: string | null;
  route?: string | null;
  modelId?: string | null;
  runtime?: 'LEGACY' | 'V2';
  ownerName?: string;
}

/** Crea el AgentRun + evento run.created. null si la capa no está migrada. */
export async function startRun(input: StartRunInput): Promise<RunHandle | null> {
  if (!(await runsReady())) return null;
  const tenantId = input.tenantId || DEFAULT_TENANT_ID;
  try {
    const agentId = input.agentId
      ?? (await ensurePrincipal(tenantId, input.userId, input.ownerName))?.id;
    if (!agentId) return null;
    const traceId = randomUUID();
    const run = await prisma.agentRun.create({
      data: {
        tenantId,
        agentId,
        userId: input.userId,
        conversationId: input.conversationId ?? null,
        parentRunId: input.parentRunId ?? null,
        rootRunId: 'pending', // se corrige abajo con el propio id
        taskId: input.taskId ?? null,
        missionId: input.missionId ?? null,
        route: input.route ?? null,
        modelId: input.modelId ?? null,
        runtime: input.runtime ?? 'LEGACY',
        traceId,
      },
    });
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { rootRunId: input.parentRunId ? (await prisma.agentRun.findUnique({ where: { id: input.parentRunId }, select: { rootRunId: true } }))?.rootRunId ?? input.parentRunId : run.id },
    });
    await emitRunEvent(run.id, 'run.created', {
      source: input.source ?? 'chat',
      agentId,
      route: input.route ?? null,
      modelId: input.modelId ?? null,
    });
    return { runId: run.id, traceId, agentId };
  } catch (err) {
    console.warn('[agents] startRun failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function emitRunEvent(runId: string | null, type: string, payload?: Record<string, unknown>, spanId?: string): Promise<void> {
  if (!runId || runsTableReady === false) return;
  try {
    await prisma.agentEvent.create({
      data: { runId, type, spanId: spanId ?? null, payload: (payload ?? undefined) as never },
    });
  } catch {
    runsTableReady = false;
  }
}

export interface FinishRunInput {
  status: 'done' | 'failed' | 'cancelled' | 'blocked' | 'awaiting_approval';
  tokensIn?: number;
  tokensOut?: number;
  modelCostUsd?: number;
  error?: string;
}

export async function finishRun(runId: string | null, result: FinishRunInput): Promise<void> {
  if (!runId || runsTableReady === false) return;
  try {
    await prisma.agentRun.update({
      where: { id: runId },
      data: {
        status: result.status,
        tokensIn: result.tokensIn ?? 0,
        tokensOut: result.tokensOut ?? 0,
        modelCostUsd: result.modelCostUsd ?? 0,
        error: result.error ?? null,
        completedAt: result.status === 'awaiting_approval' ? null : new Date(),
      },
    });
    await emitRunEvent(runId, `run.${result.status}`, {
      tokensIn: result.tokensIn ?? 0,
      tokensOut: result.tokensOut ?? 0,
      error: result.error ?? null,
    });
  } catch {
    runsTableReady = false;
  }
}
