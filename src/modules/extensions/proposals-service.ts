import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { isKnownPermission } from '@/modules/auth/permissions';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@/modules/ai/tools/registry';
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
 *
 * Who decides (plan 5.4 / 5.8):
 * - the proposing user, or a human inside the proposal's `approverScope`
 *   (listed in `userIds` — responsible, backup… — or holding its `permission`);
 * - a bot user (`User.isBot`, or an `agent_*` role) never approves nor rejects,
 *   not even its own proposals: agent proposals are decided by the humans of
 *   the scope and run with the approving human as actor;
 * - tools marked `requiresSecondApproval` go `pending → awaiting_second_approval`
 *   on the first approval; the second signer must be a different person holding
 *   the second-approval permission (scope permission → tool permission →
 *   `operations.admin`), and only then the tool runs.
 * Anyone outside that set gets "not found", so proposals of others stay hidden.
 */

const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/** States in which a proposal can still be approved or rejected. */
export const DECIDABLE_PROPOSAL_STATUSES = ['pending', 'awaiting_second_approval'] as const;

/** Permission required for the second signature when neither the scope nor the tool names a known one. */
export const SECOND_APPROVAL_FALLBACK_PERMISSION = 'operations.admin';

const MAX_SCOPE_USER_IDS = 50;

export class ProposalError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ProposalError';
  }
}

/** Approval scope fixed by agent turns: who (besides the proposer) may decide a proposal. */
export interface ApproverScope {
  caseId?: string;
  areaKey?: string;
  /** Humans who may decide (area responsible, backup, case owner…). */
  userIds: string[];
  /** Holders of this permission may also decide; it is also the second-signature permission. */
  permission?: string;
}

function shortString(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

/** Validates a stored/incoming scope. Returns null when it grants nothing and names nothing. Pure. */
export function normalizeApproverScope(value: unknown): ApproverScope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const userIds = Array.isArray(raw.userIds)
    ? [
        ...new Set(
          raw.userIds.map((id) => shortString(id, 64)).filter((id): id is string => Boolean(id))
        ),
      ].slice(0, MAX_SCOPE_USER_IDS)
    : [];
  const scope: ApproverScope = { userIds };
  const caseId = shortString(raw.caseId);
  const areaKey = shortString(raw.areaKey, 64);
  const permission = shortString(raw.permission, 120);
  if (caseId) scope.caseId = caseId;
  if (areaKey) scope.areaKey = areaKey;
  if (permission) scope.permission = permission;
  if (!caseId && !areaKey && !permission && userIds.length === 0) return null;
  return scope;
}

function holdsKnownPermission(actor: CurrentUser, permission: string | null | undefined): boolean {
  return Boolean(permission && isKnownPermission(permission) && hasPermission(actor, permission));
}

/** The actor is listed in the scope or holds its (known) permission. Pure. */
export function isInApproverScope(actor: CurrentUser, scope: ApproverScope | null): boolean {
  if (!scope) return false;
  return scope.userIds.includes(actor.id) || holdsKnownPermission(actor, scope.permission);
}

type ToolWithSecondApproval = ToolDefinition & { requiresSecondApproval?: boolean };

/** Whether the tool demands two distinct signatures before running. */
export function toolRequiresSecondApproval(tool: ToolDefinition | undefined): boolean {
  return (tool as ToolWithSecondApproval | undefined)?.requiresSecondApproval === true;
}

/** Permission of the second signature: scope → tool → `operations.admin` (only known keys). Pure. */
export function secondApprovalPermissionFor(
  scope: ApproverScope | null,
  tool: Pick<ToolDefinition, 'requiredPermission'> | undefined
): string {
  if (scope?.permission && isKnownPermission(scope.permission)) return scope.permission;
  if (tool?.requiredPermission && isKnownPermission(tool.requiredPermission))
    return tool.requiredPermission;
  return SECOND_APPROVAL_FALLBACK_PERMISSION;
}

export interface ProposalDecisionSubject {
  userId: string;
  status: string;
  approverScope?: unknown;
  decisionBy?: string | null;
}

export type ProposalDecisionAccess =
  | { ok: true; kind: 'final' | 'first' | 'second' | 'reject' }
  | { ok: false; status: 403 | 404 | 409; message: string };

/**
 * Who may decide what, without I/O (the bot check needs the database and is done by the
 * callers). `kind`: `final` runs the tool, `first` records the first of two signatures,
 * `second` completes them and runs, `reject` closes it.
 */
export function evaluateProposalDecision(input: {
  actor: CurrentUser;
  proposal: ProposalDecisionSubject;
  decision: 'approve' | 'reject';
  requiresSecondApproval: boolean;
  secondApprovalPermission: string;
}): ProposalDecisionAccess {
  const { actor, proposal, decision } = input;
  const scope = normalizeApproverScope(proposal.approverScope);
  const eligible = actor.id === proposal.userId || isInApproverScope(actor, scope);
  const awaitingSecond = proposal.status === 'awaiting_second_approval';
  const canSignSecond = awaitingSecond && holdsKnownPermission(actor, input.secondApprovalPermission);

  if (!eligible && !canSignSecond) {
    return { ok: false, status: 404, message: 'Propuesta no encontrada' };
  }
  if (proposal.status !== 'pending' && !awaitingSecond) {
    return { ok: false, status: 409, message: `La propuesta ya está ${proposal.status}` };
  }
  if (decision === 'reject') return { ok: true, kind: 'reject' };
  if (!awaitingSecond) return { ok: true, kind: input.requiresSecondApproval ? 'first' : 'final' };
  if (proposal.decisionBy && proposal.decisionBy === actor.id) {
    return {
      ok: false,
      status: 403,
      message: 'La segunda firma debe ser de una persona distinta a quien dio la primera',
    };
  }
  if (!canSignSecond) {
    return {
      ok: false,
      status: 403,
      message: `La segunda firma requiere el permiso ${input.secondApprovalPermission}`,
    };
  }
  return { ok: true, kind: 'second' };
}

/** Bots (User.isBot or an agent_* system role) never decide proposals; inactive users neither. */
async function assertHumanDecider(actor: CurrentUser): Promise<void> {
  if (actor.roleKeys.some((key) => key.startsWith('agent_'))) {
    throw new ProposalError('Un usuario bot no puede aprobar ni rechazar propuestas', 403);
  }
  const user = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { isBot: true, isActive: true },
  });
  if (!user || !user.isActive) {
    throw new ProposalError('Usuario no autorizado para decidir propuestas', 403);
  }
  if (user.isBot) {
    throw new ProposalError('Un usuario bot no puede aprobar ni rechazar propuestas', 403);
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
  /** Set by agent turns: humans (and a permission) who may decide besides the proposer. */
  approverScope?: ApproverScope | null;
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
  const approverScope = normalizeApproverScope(input.approverScope);
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
      ...(approverScope
        ? { approverScope: approverScope as unknown as Prisma.InputJsonValue }
        : {}),
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
    },
  });
}

export async function getProposalForUser(id: string, userId: string) {
  return prisma.aiProposal.findFirst({ where: { id, userId } });
}

type ProposalRow = Awaited<ReturnType<typeof prisma.aiProposal.findMany>>[number];

/** Tool definitions of awaiting rows whose scope names no permission (second-signature fallback). */
async function toolsForSecondPermission(rows: ProposalRow[]): Promise<Map<string, ToolDefinition>> {
  const needed = rows.filter(
    (r) =>
      r.status === 'awaiting_second_approval' && !normalizeApproverScope(r.approverScope)?.permission
  );
  const tools = new Map<string, ToolDefinition>();
  if (needed.length === 0) return tools;
  const { getToolDefinition } = await import('@/modules/ai/tools/registry');
  for (const row of needed) {
    const tool = getToolDefinition(row.toolName);
    if (tool) tools.set(row.toolName, tool);
  }
  return tools;
}

/** Rows the actor may see: `decidableOnly` keeps those they can still approve or reject. */
async function filterVisibleTo(
  actor: CurrentUser,
  rows: ProposalRow[],
  decidableOnly: boolean
): Promise<ProposalRow[]> {
  const tools = await toolsForSecondPermission(rows);
  return rows.filter((row) => {
    const scope = normalizeApproverScope(row.approverScope);
    const access = evaluateProposalDecision({
      actor,
      proposal: row,
      decision: 'reject',
      requiresSecondApproval: false,
      secondApprovalPermission: secondApprovalPermissionFor(scope, tools.get(row.toolName)),
    });
    if (access.ok) return true;
    return !decidableOnly && access.status === 409;
  });
}

/**
 * Pending approvals.
 * - `listPendingProposals(userId, conversationId?)`: the user's own `pending` proposals
 *   (the copilot threads; unchanged contract).
 * - `listPendingProposals(actor, conversationId?)`: every proposal the actor can still
 *   decide across all surfaces — their own, those of their approver scope (listed or by
 *   permission) and those waiting for a second signature they can give.
 */
export async function listPendingProposals(
  actorOrUserId: CurrentUser | string,
  conversationId?: string
) {
  const now = new Date();
  if (typeof actorOrUserId === 'string') {
    return prisma.aiProposal.findMany({
      where: {
        userId: actorOrUserId,
        status: 'pending',
        expiresAt: { gt: now },
        ...(conversationId ? { conversationId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
  const actor = actorOrUserId;
  const rows = await prisma.aiProposal.findMany({
    where: {
      status: { in: [...DECIDABLE_PROPOSAL_STATUSES] },
      expiresAt: { gt: now },
      ...(conversationId ? { conversationId } : {}),
      OR: [{ userId: actor.id }, { approverScope: { not: Prisma.AnyNull } }],
    },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });
  return (await filterVisibleTo(actor, rows, true)).slice(0, 50);
}

/**
 * Proposals of one case room and/or area visible to the actor (proposer, scope or second
 * signer). By default only those still decidable; `includeDecided` adds the recent history.
 */
export async function listProposalsForScope(
  actor: CurrentUser,
  filter: { caseId?: string; areaKey?: string; includeDecided?: boolean; limit?: number } = {}
) {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
  const now = new Date();
  const scopeFilters: Prisma.AiProposalWhereInput[] = [];
  if (filter.caseId) scopeFilters.push({ approverScope: { path: ['caseId'], equals: filter.caseId } });
  if (filter.areaKey)
    scopeFilters.push({ approverScope: { path: ['areaKey'], equals: filter.areaKey } });
  const rows = await prisma.aiProposal.findMany({
    where: {
      ...(filter.includeDecided
        ? { createdAt: { gt: new Date(now.getTime() - 7 * PROPOSAL_TTL_MS) } }
        : { status: { in: [...DECIDABLE_PROPOSAL_STATUSES] }, expiresAt: { gt: now } }),
      approverScope: { not: Prisma.AnyNull },
      ...(scopeFilters.length > 0 ? { AND: scopeFilters } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.max(limit * 3, 150),
  });
  return (await filterVisibleTo(actor, rows, !filter.includeDecided)).slice(0, limit);
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
  userId?: string;
  approverScope?: unknown;
  decisionBy?: string | null;
  secondDecisionBy?: string | null;
  secondDecidedAt?: Date | null;
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
    proposedBy: p.userId ?? null,
    approverScope: normalizeApproverScope(p.approverScope),
    decisionBy: p.decisionBy ?? null,
    secondDecisionBy: p.secondDecisionBy ?? null,
    secondDecidedAt: p.secondDecidedAt?.toISOString() ?? null,
    awaitingSecondApproval: p.status === 'awaiting_second_approval',
  };
}

/** Label of the decider in the system message of the thread (usernames only: never free text). */
function deciderLabel(actor: CurrentUser, proposerId: string): string {
  return actor.id === proposerId ? 'El usuario' : `El aprobador autorizado @${actor.username}`;
}

async function addThreadMessage(conversationId: string | null, content: string): Promise<void> {
  if (!conversationId) return;
  const { addMessage } = await import('@/modules/ai/ai-sessions-service');
  await addMessage(conversationId, 'system', content, null, 0, 0, 0);
}

/**
 * Approves and executes a proposal. The stored arguments are re-hashed and
 * compared; the tool's current version/connection must still match; only the
 * proposer or a human of the approver scope can approve (bots never). Tools
 * requiring a second approval wait for a distinct second signer with the
 * permission. Uncertain outcomes stay "pending_review".
 */
export async function approveProposal(
  actor: CurrentUser,
  id: string
): Promise<{ proposal: ReturnType<typeof toProposalDTO>; execution: ToolExecutionResult }> {
  const proposal = await prisma.aiProposal.findUnique({ where: { id } });
  if (!proposal) throw new ProposalError('Propuesta no encontrada', 404);
  const scope = normalizeApproverScope(proposal.approverScope);

  let tool: ToolDefinition | undefined;
  if ((DECIDABLE_PROPOSAL_STATUSES as readonly string[]).includes(proposal.status)) {
    const { getToolDefinition } = await import('@/modules/ai/tools/registry');
    const { refreshExternalTools } = await import('./external-tools');
    await refreshExternalTools();
    tool = getToolDefinition(proposal.toolName);
  }

  const access = evaluateProposalDecision({
    actor,
    proposal,
    decision: 'approve',
    requiresSecondApproval: toolRequiresSecondApproval(tool),
    secondApprovalPermission: secondApprovalPermissionFor(scope, tool),
  });
  if (!access.ok) throw new ProposalError(access.message, access.status);
  await assertHumanDecider(actor);

  if (proposal.expiresAt.getTime() < Date.now()) {
    await prisma.aiProposal.update({ where: { id }, data: { status: 'expired' } });
    throw new ProposalError('La propuesta expiró', 410);
  }

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

  const now = new Date();
  // Claim atomically so two clicks never execute (or sign) twice.
  if (access.kind === 'first') {
    const claimed = await prisma.aiProposal.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'awaiting_second_approval', decisionBy: actor.id, decidedAt: now },
    });
    if (claimed.count === 0) throw new ProposalError('La propuesta ya fue procesada', 409);
    const updated = await prisma.aiProposal.findUnique({ where: { id } });
    await addThreadMessage(
      proposal.conversationId,
      `[Sistema] ${deciderLabel(actor, proposal.userId)} dio la PRIMERA FIRMA de la propuesta ${id} (${proposal.toolName}). Aún no se ejecuta: falta la segunda firma de otra persona con el permiso ${secondApprovalPermissionFor(scope, tool)}. Acción: ${proposal.summary.slice(0, 200)}`
    );
    return {
      proposal: toProposalDTO(updated ?? { ...proposal, status: 'awaiting_second_approval', decisionBy: actor.id, decidedAt: now }),
      execution: {
        success: false,
        needsApproval: true,
        error: 'Falta la segunda firma de otra persona con permiso',
        errorCode: 'awaiting_second_approval',
        durationMs: 0,
      },
    };
  }

  const claimed =
    access.kind === 'second'
      ? await prisma.aiProposal.updateMany({
          where: { id, status: 'awaiting_second_approval' },
          data: { status: 'approved', secondDecisionBy: actor.id, secondDecidedAt: now },
        })
      : await prisma.aiProposal.updateMany({
          where: { id, status: 'pending' },
          data: { status: 'approved', decisionBy: actor.id, decidedAt: now },
        });
  if (claimed.count === 0) throw new ProposalError('La propuesta ya fue procesada', 409);

  const executionContext = {
    conversationId: proposal.conversationId ?? undefined,
    messageId: proposal.messageId ?? undefined,
    approvedProposalId: id,
    skipApproval: true,
    recipient: proposal.recipient ?? undefined,
    fileIds: proposal.fileIds,
    contextHash: proposal.contextHash ?? undefined,
    ...(scope
      ? { approverScope: scope, ...(scope.areaKey ? { agentAreaKey: scope.areaKey } : {}) }
      : {}),
  } as ToolExecutionContext;
  const execution = await executeApproved(tool.name, actor, proposal.args, executionContext);

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

  // An approved proposal of an agent that failed to run wakes its proposer once (`action_failed`).
  if (!execution.success && !execution.uncertain && !execution.needsApproval) {
    await reportFailedAgentProposal(
      { id, userId: proposal.userId, toolName: proposal.toolName },
      scope,
      execution.error ?? 'Error desconocido'
    );
  }

  // Make the outcome visible to the assistant in the next turn.
  const outcome = execution.uncertain
    ? 'resultado incierto (pendiente de revisión: la operación pudo completarse)'
    : execution.success
      ? 'ejecutada correctamente'
      : `falló: ${execution.error ?? 'error'}`;
  const resultText =
    execution.result !== undefined ? JSON.stringify(redactDeep(execution.result)).slice(0, 600) : '';
  const verb = access.kind === 'second' ? 'dio la SEGUNDA FIRMA y APROBÓ' : 'APROBÓ';
  await addThreadMessage(
    proposal.conversationId,
    `[Sistema] ${deciderLabel(actor, proposal.userId)} ${verb} la propuesta ${id} (${proposal.toolName}): ${outcome}. Acción: ${proposal.summary.slice(0, 200)}${resultText ? ` Resultado: ${resultText}` : ''}`
  );

  return { proposal: toProposalDTO(updated), execution };
}

/**
 * When the proposer is an agent bot, enqueues its `action_failed` turn (one per
 * proposal, deduplicated by the dispatcher). Covers every decision route
 * (assistant, inbox, chat, operations). Never throws: the decision already happened.
 */
async function reportFailedAgentProposal(
  proposal: { id: string; userId: string; toolName: string },
  scope: ApproverScope | null,
  error: string
): Promise<void> {
  try {
    const identity = await prisma.agentIdentity.findUnique({
      where: { botUserId: proposal.userId },
      select: { key: true },
    });
    if (!identity) return;
    const { enqueueProposalFailed } = await import('@/modules/agents/dispatcher');
    await enqueueProposalFailed({
      proposalId: proposal.id,
      agentKey: identity.key,
      toolName: proposal.toolName,
      error,
      caseId: scope?.caseId ?? null,
      areaKey: scope?.areaKey ?? null,
    });
  } catch (err) {
    console.warn(
      '[proposals] action_failed turn not enqueued:',
      err instanceof Error ? err.message : err
    );
  }
}

async function executeApproved(
  toolName: string,
  actor: CurrentUser,
  args: unknown,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const { executeTool } = await import('@/modules/ai/tools/registry');
  return executeTool(toolName, actor, args, ctx);
}

export async function rejectProposal(actor: CurrentUser, id: string, reason?: string) {
  const proposal = await prisma.aiProposal.findUnique({ where: { id } });
  if (!proposal) throw new ProposalError('Propuesta no encontrada', 404);
  const scope = normalizeApproverScope(proposal.approverScope);
  let tool: ToolDefinition | undefined;
  if (proposal.status === 'awaiting_second_approval' && !scope?.permission) {
    const { getToolDefinition } = await import('@/modules/ai/tools/registry');
    tool = getToolDefinition(proposal.toolName);
  }
  const access = evaluateProposalDecision({
    actor,
    proposal,
    decision: 'reject',
    requiresSecondApproval: false,
    secondApprovalPermission: secondApprovalPermissionFor(scope, tool),
  });
  if (!access.ok) throw new ProposalError(access.message, access.status);
  await assertHumanDecider(actor);

  const now = new Date();
  const note = reason?.slice(0, 500) ?? null;
  const claimed = await prisma.aiProposal.updateMany({
    where: { id, status: proposal.status },
    data:
      proposal.status === 'awaiting_second_approval'
        ? { status: 'rejected', secondDecisionBy: actor.id, secondDecidedAt: now, error: note }
        : { status: 'rejected', decisionBy: actor.id, decidedAt: now, error: note },
  });
  if (claimed.count === 0) throw new ProposalError('La propuesta ya fue procesada', 409);
  const updated = await prisma.aiProposal.findUnique({ where: { id } });

  await addThreadMessage(
    proposal.conversationId,
    `[Sistema] ${deciderLabel(actor, proposal.userId)} RECHAZÓ la propuesta ${id} (${proposal.toolName})${reason ? `: ${reason}` : ''}.`
  );
  return toProposalDTO(
    updated ?? { ...proposal, status: 'rejected', decisionBy: actor.id, decidedAt: now, error: note }
  );
}

/** Invalidates pending proposals of a tool (version/connection change, suspension). */
export async function invalidateProposalsForTool(
  toolName: string,
  reason: string
): Promise<number> {
  const res = await prisma.aiProposal.updateMany({
    where: { toolName, status: { in: [...DECIDABLE_PROPOSAL_STATUSES] } },
    data: { status: 'invalidated', error: reason },
  });
  return res.count;
}

export async function expireProposals(now: Date = new Date()): Promise<number> {
  const res = await prisma.aiProposal.updateMany({
    where: { status: { in: [...DECIDABLE_PROPOSAL_STATUSES] }, expiresAt: { lt: now } },
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
