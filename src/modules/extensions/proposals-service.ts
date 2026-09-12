import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { ToolDefinition, ToolExecutionResult } from '@/modules/ai/tools/registry';
import { canonicalJson } from './json-schema-to-zod';
import { redactDeep } from './secrets';

/**
 * Approval proposals for side-effecting actions.
 *
 * A proposal binds: tool + version + connection + arguments + recipient +
 * files + business context + approving user. Changing any material element
 * (or the tool's version/connection while pending) invalidates it. Approval
 * executes EXACTLY the stored arguments; the hash is recomputed and compared
 * before running.
 */

const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

export class ProposalError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ProposalError';
  }
}

export function computeProposalHash(input: {
  toolName: string;
  toolVersion: string | null;
  connectionId: string | null;
  args: unknown;
  recipient: string | null;
  fileIds: string[];
  contextHash: string | null;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        t: input.toolName,
        v: input.toolVersion,
        c: input.connectionId,
        a: input.args,
        r: input.recipient,
        f: [...input.fileIds].sort(),
        x: input.contextHash,
      })
    )
    .digest('hex');
}

export interface CreateProposalInput {
  actor: CurrentUser;
  tool: ToolDefinition;
  args: unknown;
  conversationId?: string;
  messageId?: string;
  summary: string;
  recipient?: string;
  fileIds?: string[];
  contextHash?: string;
  connectionId?: string | null;
}

export async function createProposal(input: CreateProposalInput) {
  const fileIds = input.fileIds ?? [];
  const argsHash = computeProposalHash({
    toolName: input.tool.name,
    toolVersion: input.tool.version ?? null,
    connectionId: input.connectionId ?? null,
    args: input.args,
    recipient: input.recipient ?? null,
    fileIds,
    contextHash: input.contextHash ?? null,
  });
  return prisma.aiProposal.create({
    data: {
      conversationId: input.conversationId ?? null,
      messageId: input.messageId ?? null,
      userId: input.actor.id,
      toolName: input.tool.name,
      toolVersion: input.tool.version ?? null,
      capabilityId: input.tool.capabilityId ?? null,
      connectionId: input.connectionId ?? null,
      argsHash,
      args: redactDeep(input.args) as Prisma.InputJsonValue,
      summary: input.summary.slice(0, 2000),
      recipient: input.recipient ?? null,
      fileIds,
      contextHash: input.contextHash ?? null,
      effect: input.tool.effect ?? 'read',
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
    },
  });
}

export async function getProposalForUser(id: string, userId: string) {
  return prisma.aiProposal.findFirst({ where: { id, userId } });
}

export async function listPendingProposals(userId: string, conversationId?: string) {
  return prisma.aiProposal.findMany({
    where: {
      userId,
      status: 'pending',
      expiresAt: { gt: new Date() },
      ...(conversationId ? { conversationId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

export function toProposalDTO(p: {
  id: string;
  conversationId: string | null;
  toolName: string;
  summary: string;
  effect: string;
  status: string;
  args: unknown;
  recipient: string | null;
  fileIds: string[];
  result: unknown;
  error: string | null;
  expiresAt: Date;
  createdAt: Date;
  decidedAt: Date | null;
  executedAt: Date | null;
}) {
  return {
    id: p.id,
    conversationId: p.conversationId,
    toolName: p.toolName,
    summary: p.summary,
    effect: p.effect,
    status: p.status,
    args: p.args,
    recipient: p.recipient,
    fileIds: p.fileIds,
    result: p.result,
    error: p.error,
    expiresAt: p.expiresAt.toISOString(),
    createdAt: p.createdAt.toISOString(),
    decidedAt: p.decidedAt?.toISOString() ?? null,
    executedAt: p.executedAt?.toISOString() ?? null,
  };
}

/**
 * Approves and executes a proposal. The stored arguments are re-hashed and
 * compared; the tool's current version/connection must still match; only the
 * proposing user can approve. Uncertain outcomes stay "pending_review".
 */
export async function approveProposal(
  actor: CurrentUser,
  id: string
): Promise<{ proposal: ReturnType<typeof toProposalDTO>; execution: ToolExecutionResult }> {
  const proposal = await prisma.aiProposal.findUnique({ where: { id } });
  if (!proposal || proposal.userId !== actor.id)
    throw new ProposalError('Propuesta no encontrada', 404);
  if (proposal.status !== 'pending')
    throw new ProposalError(`La propuesta ya está ${proposal.status}`, 409);
  if (proposal.expiresAt.getTime() < Date.now()) {
    await prisma.aiProposal.update({ where: { id }, data: { status: 'expired' } });
    throw new ProposalError('La propuesta expiró', 410);
  }

  const { getToolDefinition, executeTool } = await import('@/modules/ai/tools/registry');
  const { refreshExternalTools } = await import('./external-tools');
  await refreshExternalTools();
  const tool = getToolDefinition(proposal.toolName);
  if (!tool) {
    await prisma.aiProposal.update({
      where: { id },
      data: { status: 'invalidated', error: 'La herramienta ya no existe' },
    });
    throw new ProposalError('La herramienta ya no está disponible', 409);
  }
  const expectedHash = computeProposalHash({
    toolName: tool.name,
    toolVersion: tool.version ?? null,
    connectionId: proposal.connectionId,
    args: proposal.args,
    recipient: proposal.recipient,
    fileIds: proposal.fileIds,
    contextHash: proposal.contextHash,
  });
  if (expectedHash !== proposal.argsHash) {
    await prisma.aiProposal.update({
      where: { id },
      data: {
        status: 'invalidated',
        error: 'La herramienta o sus argumentos cambiaron desde que se propuso',
      },
    });
    throw new ProposalError('La propuesta quedó invalidada por un cambio material', 409);
  }

  // Claim atomically so two clicks never execute twice.
  const claimed = await prisma.aiProposal.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'approved', decisionBy: actor.id, decidedAt: new Date() },
  });
  if (claimed.count === 0) throw new ProposalError('La propuesta ya fue procesada', 409);

  const execution = await executeTool(tool.name, actor, proposal.args, {
    conversationId: proposal.conversationId ?? undefined,
    messageId: proposal.messageId ?? undefined,
    approvedProposalId: id,
    skipApproval: true,
    recipient: proposal.recipient ?? undefined,
    fileIds: proposal.fileIds,
    contextHash: proposal.contextHash ?? undefined,
  });

  const status = execution.uncertain ? 'pending_review' : execution.success ? 'executed' : 'failed';
  const updated = await prisma.aiProposal.update({
    where: { id },
    data: {
      status,
      executedAt: new Date(),
      result:
        execution.result === undefined
          ? Prisma.JsonNull
          : (redactDeep(execution.result) as Prisma.InputJsonValue),
      error: execution.error ?? null,
    },
  });

  // Make the outcome visible to the assistant in the next turn.
  if (proposal.conversationId) {
    const { addMessage } = await import('@/modules/ai/ai-sessions-service');
    const outcome = execution.uncertain
      ? 'resultado incierto (pendiente de revisión: la operación pudo completarse)'
      : execution.success
        ? 'ejecutada correctamente'
        : `falló: ${execution.error ?? 'error'}`;
    const resultText =
      execution.result !== undefined
        ? JSON.stringify(redactDeep(execution.result)).slice(0, 4000)
        : '';
    await addMessage(
      proposal.conversationId,
      'system',
      `[Sistema] El usuario APROBÓ la propuesta ${id} (${proposal.toolName}): ${outcome}.${resultText ? ` Resultado: ${resultText}` : ''}`,
      null,
      0,
      0,
      0
    );
  }

  return { proposal: toProposalDTO(updated), execution };
}

export async function rejectProposal(actor: CurrentUser, id: string, reason?: string) {
  const proposal = await prisma.aiProposal.findUnique({ where: { id } });
  if (!proposal || proposal.userId !== actor.id)
    throw new ProposalError('Propuesta no encontrada', 404);
  if (proposal.status !== 'pending')
    throw new ProposalError(`La propuesta ya está ${proposal.status}`, 409);
  const updated = await prisma.aiProposal.update({
    where: { id },
    data: {
      status: 'rejected',
      decisionBy: actor.id,
      decidedAt: new Date(),
      error: reason?.slice(0, 500) ?? null,
    },
  });
  if (proposal.conversationId) {
    const { addMessage } = await import('@/modules/ai/ai-sessions-service');
    await addMessage(
      proposal.conversationId,
      'system',
      `[Sistema] El usuario RECHAZÓ la propuesta ${id} (${proposal.toolName})${reason ? `: ${reason}` : ''}.`,
      null,
      0,
      0,
      0
    );
  }
  return toProposalDTO(updated);
}

/** Invalidates pending proposals of a tool (version/connection change, suspension). */
export async function invalidateProposalsForTool(
  toolName: string,
  reason: string
): Promise<number> {
  const res = await prisma.aiProposal.updateMany({
    where: { toolName, status: 'pending' },
    data: { status: 'invalidated', error: reason },
  });
  return res.count;
}

export async function expireProposals(now: Date = new Date()): Promise<number> {
  const res = await prisma.aiProposal.updateMany({
    where: { status: 'pending', expiresAt: { lt: now } },
    data: { status: 'expired' },
  });
  return res.count;
}

/** Operator resolution of an uncertain outcome after reconciling with the external system. */
export async function resolvePendingReview(
  actor: CurrentUser,
  id: string,
  outcome: 'executed' | 'failed',
  note?: string
) {
  const proposal = await prisma.aiProposal.findUnique({ where: { id } });
  if (!proposal) throw new ProposalError('Propuesta no encontrada', 404);
  if (proposal.status !== 'pending_review')
    throw new ProposalError('La propuesta no está pendiente de revisión', 409);
  return toProposalDTO(
    await prisma.aiProposal.update({
      where: { id },
      data: { status: outcome, decisionBy: actor.id, error: note?.slice(0, 500) ?? proposal.error },
    })
  );
}
