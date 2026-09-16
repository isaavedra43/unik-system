import { randomUUID } from 'crypto';
import { Prisma, type ApprovalRequest } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { SUPER_ADMIN_ROLE_KEY } from '@/modules/auth/constants';
import { assertKnownPermission, isKnownPermission } from '@/modules/auth/permissions';
import { takeApprovalFirstSignature } from './approval-first-signature';
import {
  executeCommand,
  registerCommand,
  requireCommandContext,
  versionedAggregate,
  type CommandContext,
  type CommandResult,
} from './commands';
import { OperationsError } from './errors';
import { toOperationalJson } from './events-service';
import { getOperationsConfig, type OperationsSettings } from './operations-config';
import {
  APPROVAL_DECISIONS,
  APPROVAL_SCOPES,
  APPROVAL_SCOPE_LABELS,
  OPS_EVENTS,
  WORK_ITEM_OPEN_STATUSES,
  isAreaKey,
  type ApprovalDecision,
  type ApprovalScope,
  type ApprovalStatus,
  type AreaKey,
} from './types';

/**
 * Business approvals shared by every operational module (plan section 6.0):
 * purchases, expenses, payments, payroll, production incidents and inventory
 * adjustments. They are NOT AI proposals (`AiProposal`).
 *
 * - `requestApproval(tx, …)` runs inside the module's command: resolves the
 *   `ApprovalPolicy` (or the defaults derived from the operations config when
 *   the scope has no rows), auto-approves when the policy requires zero
 *   approvals, otherwise creates one `approval` work item per eligible
 *   approver (active human users holding an approver role of the policy, the
 *   module's approver permission, `operations.admin` or super_admin; never the
 *   requester).
 * - `decideApproval(actor, …)` is the `approval.decide` command: one vote per
 *   user, distinct approvers, a single rejection rejects, `requiredApprovals`
 *   distinct approvals approve. Bots can never vote.
 * - Modules react with `onApprovalDecided(targetType, handler)`; handlers run
 *   inside the same transaction as the decision.
 * - Primera firma heredada de la IA (plan 5.4): cuando la solicitud la abre la
 *   ejecución de una propuesta de IA ya aprobada por una persona, esa decisión
 *   cuenta como su voto (`approval.voted`) siempre que cumpla la política; así
 *   no se le piden dos clics por lo mismo ni queda excluida como solicitante.
 *   La firma viaja por `runWithApprovalFirstSignature` (ver
 *   `approval-first-signature.ts`), no por los argumentos de cada módulo.
 */

const MAX_APPROVERS = 25;

// ---------------------------------------------------------------------------
// Scope → approver permission
// ---------------------------------------------------------------------------

/** Area that owns the approval work items of each scope by default. */
export const APPROVAL_SCOPE_AREA: Record<ApprovalScope, AreaKey> = {
  expense: 'contabilidad',
  procurement: 'compras',
  payment: 'contabilidad',
  payroll: 'contabilidad',
  production_incident: 'manufactura',
  inventory_adjustment: 'inventario',
};

const FALLBACK_APPROVER_PERMISSION = 'operations.admin';

type GlobalWithApprovals = typeof globalThis & {
  __unikApprovalScopePermissions?: Map<ApprovalScope, string>;
  __unikApprovalReactions?: Map<string, Set<ApprovalDecidedHandler>>;
};

function scopePermissions(): Map<ApprovalScope, string> {
  const scope = globalThis as GlobalWithApprovals;
  if (!scope.__unikApprovalScopePermissions) scope.__unikApprovalScopePermissions = new Map();
  return scope.__unikApprovalScopePermissions;
}

/** A module declares the permission that makes a user an approver of its scope (e.g. purchases). */
export function registerApprovalScopePermission(scope: ApprovalScope, permissionKey: string): void {
  assertKnownPermission(permissionKey);
  scopePermissions().set(scope, permissionKey);
}

/** Permissions that qualify an approver of `scope` (module permission, then `operations.admin`). */
export function approverPermissionsFor(scope: ApprovalScope): string[] {
  const modulePermission = scopePermissions().get(scope);
  return [...new Set([modulePermission, FALLBACK_APPROVER_PERMISSION])].filter(
    (key): key is string => typeof key === 'string' && isKnownPermission(key)
  );
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

export interface ApprovalPolicyRule {
  /** null for defaults derived from the configuration. */
  id: string | null;
  scope: ApprovalScope;
  categoryId: string | null;
  minAmount: Prisma.Decimal;
  maxAmount: Prisma.Decimal | null;
  currency: string;
  requiredApprovals: number;
  /** null means use the global Operations deadline. */
  expiresAfterMinutes: number | null;
  approverRoleKeys: string[];
}

const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);

function rule(
  scope: ApprovalScope,
  min: Prisma.Decimal.Value,
  max: Prisma.Decimal.Value | null,
  requiredApprovals: number
): ApprovalPolicyRule {
  return {
    id: null,
    scope,
    categoryId: null,
    minAmount: D(min),
    maxAmount: max === null ? null : D(max),
    currency: 'MXN',
    requiredApprovals,
    expiresAfterMinutes: null,
    approverRoleKeys: [],
  };
}

/**
 * Defaults when a scope has no `ApprovalPolicy` rows (MXN, editable through
 * `approvalThresholds` in the operations config):
 * - procurement and payment: 1 approval, 2 distinct approvals from the double-approval threshold;
 * - expense: auto-approved below the threshold, 1 approval from it;
 * - payroll: always 2; production incidents and inventory adjustments: 1.
 */
export function defaultApprovalPolicies(
  thresholds: OperationsSettings['approvalThresholds']
): ApprovalPolicyRule[] {
  const doubleFrom = thresholds.procurementDoubleApprovalMxn;
  const expenseAuto = thresholds.expenseAutoApproveMxn;
  return [
    rule('procurement', 0, doubleFrom, 1),
    rule('procurement', doubleFrom, null, 2),
    rule('payment', 0, doubleFrom, 1),
    rule('payment', doubleFrom, null, 2),
    rule('expense', 0, expenseAuto, 0),
    rule('expense', expenseAuto, null, 1),
    rule('payroll', 0, null, 2),
    rule('production_incident', 0, null, 1),
    rule('inventory_adjustment', 0, null, 1),
  ].filter((r) => r.maxAmount === null || r.maxAmount.greaterThan(r.minAmount));
}

export interface ApprovalSubject {
  scope: ApprovalScope;
  amount: Prisma.Decimal;
  currency: string;
  categoryId?: string | null;
}

/** Most specific applicable rule: category match first, then the highest minimum. `[min, max)` ranges. */
export function selectApprovalPolicy(
  rules: ApprovalPolicyRule[],
  subject: ApprovalSubject
): ApprovalPolicyRule | null {
  const candidates = rules.filter(
    (r) =>
      r.scope === subject.scope &&
      r.currency === subject.currency &&
      subject.amount.greaterThanOrEqualTo(r.minAmount) &&
      (r.maxAmount === null || subject.amount.lessThan(r.maxAmount)) &&
      (r.categoryId === null || r.categoryId === (subject.categoryId ?? null))
  );
  candidates.sort((a, b) => {
    const specificity = Number(b.categoryId !== null) - Number(a.categoryId !== null);
    if (specificity !== 0) return specificity;
    return b.minAmount.comparedTo(a.minAmount);
  });
  return candidates[0] ?? null;
}

/** When nothing matches (other currency, gap between rules): never auto-approve, use the strictest count. */
export function fallbackApprovalRule(
  scope: ApprovalScope,
  rules: ApprovalPolicyRule[]
): ApprovalPolicyRule {
  const sameScope = rules.filter((r) => r.scope === scope);
  const required = Math.max(1, ...sameScope.map((r) => r.requiredApprovals));
  return { ...rule(scope, 0, null, required), currency: '*' };
}

export interface ApprovalVote {
  userId: string;
  decision: ApprovalDecision;
  at: string;
  note: string | null;
}

export function parseApprovalDecisions(value: Prisma.JsonValue | null | undefined): ApprovalVote[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const e = entry as Record<string, unknown>;
    if (typeof e.userId !== 'string') return [];
    if (e.decision !== 'approve' && e.decision !== 'reject') return [];
    return [
      {
        userId: e.userId,
        decision: e.decision,
        at: typeof e.at === 'string' ? e.at : '',
        note: typeof e.note === 'string' ? e.note : null,
      },
    ];
  });
}

export type VoteCheck = 'ok' | 'self_approval' | 'already_voted';

export function checkVote(
  votes: ApprovalVote[],
  userId: string,
  requestedByUserId: string
): VoteCheck {
  if (userId === requestedByUserId) return 'self_approval';
  if (votes.some((vote) => vote.userId === userId)) return 'already_voted';
  return 'ok';
}

export interface ApprovalEvaluation {
  status: Extract<ApprovalStatus, 'pending' | 'approved' | 'rejected'>;
  approvals: number;
  rejections: number;
}

/** One rejection rejects; `requiredApprovals` distinct approving users approve. */
export function evaluateApproval(
  votes: ApprovalVote[],
  requiredApprovals: number
): ApprovalEvaluation {
  const approvers = new Set(votes.filter((v) => v.decision === 'approve').map((v) => v.userId));
  const rejecters = new Set(votes.filter((v) => v.decision === 'reject').map((v) => v.userId));
  if (rejecters.size > 0)
    return { status: 'rejected', approvals: approvers.size, rejections: rejecters.size };
  if (approvers.size >= Math.max(1, requiredApprovals)) {
    return { status: 'approved', approvals: approvers.size, rejections: 0 };
  }
  return { status: 'pending', approvals: approvers.size, rejections: 0 };
}

/** Human with an approver role of the policy, the scope's approver permission, operations.admin or super_admin. */
export function isEligibleApprover(
  user: CurrentUser,
  scope: ApprovalScope,
  approverRoleKeys: string[]
): boolean {
  if (user.roleKeys.some((key) => approverRoleKeys.includes(key))) return true;
  return approverPermissionsFor(scope).some((key) => hasPermission(user, key));
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

export interface ApprovalDecidedEvent {
  approvalRequest: ApprovalRequest;
  status: 'approved' | 'rejected';
  /**
   * True when the request was decided AT REQUEST TIME, inside the requesting
   * command's own transaction — the policy auto-approved it (`decidedByUserId`
   * null) or the first signature was inherited from the person who approved the
   * AI proposal (`decidedByUserId` set). Handlers use it to skip the version
   * bump: in that case the subject is the running command's aggregate and the
   * engine already bumps it.
   */
  auto: boolean;
  decidedByUserId: string | null;
  ctx: CommandContext;
}

export type ApprovalDecidedHandler = (
  tx: Prisma.TransactionClient,
  event: ApprovalDecidedEvent
) => Promise<void>;

function reactions(): Map<string, Set<ApprovalDecidedHandler>> {
  const scope = globalThis as GlobalWithApprovals;
  if (!scope.__unikApprovalReactions) scope.__unikApprovalReactions = new Map();
  return scope.__unikApprovalReactions;
}

/** Registers a reaction for final decisions on `targetType`; runs inside the deciding transaction. */
export function onApprovalDecided(targetType: string, handler: ApprovalDecidedHandler): () => void {
  const map = reactions();
  const set = map.get(targetType) ?? new Set<ApprovalDecidedHandler>();
  set.add(handler);
  map.set(targetType, set);
  return () => {
    set.delete(handler);
  };
}

async function runReactions(
  tx: Prisma.TransactionClient,
  event: ApprovalDecidedEvent
): Promise<void> {
  for (const handler of reactions().get(event.approvalRequest.targetType) ?? []) {
    await handler(tx, event);
  }
}

// ---------------------------------------------------------------------------
// requestApproval
// ---------------------------------------------------------------------------

const amountSchema = z
  .union([z.number(), z.string(), z.instanceof(Prisma.Decimal)])
  .transform((value, issue) => {
    try {
      const decimal = new Prisma.Decimal(value);
      if (!decimal.isFinite() || decimal.isNegative()) throw new Error('negative');
      return decimal;
    } catch {
      issue.addIssue({ code: z.ZodIssueCode.custom, message: 'Monto inválido' });
      return z.NEVER;
    }
  });

const requestApprovalSchema = z.object({
  scope: z.enum(APPROVAL_SCOPES),
  targetType: z.string().trim().min(1).max(60),
  targetId: z.string().trim().min(1).max(120),
  amount: amountSchema,
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/)
    .default('MXN'),
  categoryId: z.string().trim().min(1).max(120).nullish(),
  caseId: z.string().trim().min(1).max(120).nullish(),
  areaKey: z
    .string()
    .nullish()
    .refine((v) => v === null || v === undefined || isAreaKey(v), 'Área inválida'),
  requestedByUserId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).nullish(),
  expiresAt: z.date().nullish(),
  /**
   * Floor on the distinct signatures, above the policy (e.g. a payment asked by an AI identity
   * without an identifiable human requester always needs two people). Never lowers the policy.
   */
  minApprovals: z.number().int().min(0).max(5).optional(),
});

export type RequestApprovalInput = z.input<typeof requestApprovalSchema>;

export interface RequestApprovalOutcome {
  approvalRequest: ApprovalRequest;
  status: ApprovalStatus;
  /** True ONLY when the policy required zero signatures (never when a person signed). */
  autoApproved: boolean;
  /** True when a pending request for the same target already existed (nothing new was created). */
  reused: boolean;
  approverUserIds: string[];
  workItemIds: string[];
  /**
   * Person whose decision on the AI proposal was recorded as the first business
   * signature (plan 5.4), or null when nothing was inherited.
   */
  firstSignatureByUserId: string | null;
}

function formatMoney(amount: Prisma.Decimal, currency: string): string {
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(
      amount.toNumber()
    );
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function toRule(row: {
  id: string;
  scope: string;
  categoryId: string | null;
  minAmount: Prisma.Decimal;
  maxAmount: Prisma.Decimal | null;
  currency: string;
  requiredApprovals: number;
  expiresAfterMinutes: number | null;
  approverRoleKeys: string[];
}): ApprovalPolicyRule {
  return {
    id: row.id,
    scope: row.scope as ApprovalScope,
    categoryId: row.categoryId,
    minAmount: D(row.minAmount),
    maxAmount: row.maxAmount === null ? null : D(row.maxAmount),
    currency: row.currency,
    requiredApprovals: Math.max(0, row.requiredApprovals),
    expiresAfterMinutes: row.expiresAfterMinutes,
    approverRoleKeys: row.approverRoleKeys,
  };
}

/** Roles that make a user an approver of `scope` under `approverRoleKeys`. */
function approverRoleFilters(
  scope: ApprovalScope,
  approverRoleKeys: string[]
): Prisma.RoleWhereInput[] {
  const roleFilters: Prisma.RoleWhereInput[] = [
    { key: SUPER_ADMIN_ROLE_KEY },
    { permissions: { some: { permissionKey: { in: approverPermissionsFor(scope) } } } },
  ];
  if (approverRoleKeys.length > 0) roleFilters.unshift({ key: { in: approverRoleKeys } });
  return roleFilters;
}

/** Active human users eligible to approve `scope` (never `excludeUserId`). */
export async function findEligibleApprovers(
  tx: Prisma.TransactionClient,
  scope: ApprovalScope,
  approverRoleKeys: string[],
  excludeUserId: string
): Promise<Array<{ id: string; name: string }>> {
  return tx.user.findMany({
    where: {
      isActive: true,
      isBot: false,
      id: { not: excludeUserId },
      roles: {
        some: { role: { isActive: true, OR: approverRoleFilters(scope, approverRoleKeys) } },
      },
    },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
    take: MAX_APPROVERS,
  });
}

/**
 * Whether `userId` would qualify as an approver of `scope` — the same rule as
 * `findEligibleApprovers`, but for one person and WITHOUT excluding them (they
 * are the requester when the signature is inherited from an AI proposal).
 */
export async function isEligibleApproverInTx(
  tx: Prisma.TransactionClient,
  scope: ApprovalScope,
  approverRoleKeys: string[],
  userId: string
): Promise<boolean> {
  const row = await tx.user.findFirst({
    where: {
      id: userId,
      isActive: true,
      isBot: false,
      roles: {
        some: { role: { isActive: true, OR: approverRoleFilters(scope, approverRoleKeys) } },
      },
    },
    select: { id: true },
  });
  return Boolean(row);
}

export interface ApprovalRequirement {
  policy: ApprovalPolicyRule;
  /** Distinct signatures the subject needs (0 = auto-approved by the policy). */
  requiredApprovals: number;
}

/**
 * Policy and signatures a subject would need, exactly as `requestApproval`
 * resolves them (stored `ApprovalPolicy` rows of the scope, or the defaults of
 * the operations config), without creating anything. `minApprovals` is the
 * floor for non-human requesters.
 */
export async function resolveApprovalRequirement(
  db: Pick<Prisma.TransactionClient, 'approvalPolicy'>,
  subject: ApprovalSubject,
  minApprovals?: number
): Promise<ApprovalRequirement> {
  const config = await getOperationsConfig();
  const stored = await db.approvalPolicy.findMany({
    where: { scope: subject.scope, active: true },
  });
  const rules =
    stored.length > 0 ? stored.map(toRule) : defaultApprovalPolicies(config.approvalThresholds);
  const policy =
    selectApprovalPolicy(rules, {
      ...subject,
      amount: D(subject.amount),
      categoryId: subject.categoryId ?? null,
    }) ?? fallbackApprovalRule(subject.scope, rules);
  return { policy, requiredApprovals: Math.max(policy.requiredApprovals, minApprovals ?? 0) };
}

/**
 * Opens (or reuses) the business approval of a target inside the caller's
 * command transaction. Throws `no_approvers` when fewer distinct eligible
 * approvers exist than the policy requires.
 */
export async function requestApproval(
  tx: Prisma.TransactionClient,
  input: RequestApprovalInput
): Promise<RequestApprovalOutcome> {
  const ctx = requireCommandContext(tx);
  const parsed = requestApprovalSchema.safeParse(input);
  if (!parsed.success) {
    throw new OperationsError(
      'invalid_payload',
      `Solicitud de aprobación inválida: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`
    );
  }
  const data = parsed.data;

  const existing = await tx.approvalRequest.findFirst({
    where: {
      scope: data.scope,
      targetType: data.targetType,
      targetId: data.targetId,
      status: 'pending',
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    return {
      approvalRequest: existing,
      status: 'pending',
      autoApproved: false,
      reused: true,
      approverUserIds: [],
      workItemIds: [],
      firstSignatureByUserId: null,
    };
  }

  const { policy, requiredApprovals } = await resolveApprovalRequirement(
    tx,
    {
      scope: data.scope,
      amount: data.amount,
      currency: data.currency,
      categoryId: data.categoryId ?? null,
    },
    data.minApprovals
  );
  const config = await getOperationsConfig();
  const expiresAt =
    data.expiresAt ??
    new Date(
      ctx.now.getTime() + (policy.expiresAfterMinutes ?? config.approvalExpiryMinutes) * 60_000
    );
  const areaKey = (data.areaKey as AreaKey | null | undefined) ?? APPROVAL_SCOPE_AREA[data.scope];
  const title =
    data.title ??
    `${APPROVAL_SCOPE_LABELS[data.scope]} por ${formatMoney(data.amount, data.currency)}`;
  const baseEvent = {
    scope: data.scope,
    targetType: data.targetType,
    targetId: data.targetId,
    amount: data.amount.toString(),
    currency: data.currency,
    policyId: policy.id,
    requiredApprovals,
    requestedByUserId: data.requestedByUserId,
  };
  const eventOptions = (id: string) => ({
    caseId: data.caseId ?? null,
    areaKey,
    objectType: 'approval_request',
    objectId: id,
  });

  // Plan 5.4: the decision this person already took on the AI proposal that opened this request
  // counts as their signature — but only if the policy would admit them as an approver.
  const inherited =
    requiredApprovals > 0 ? takeApprovalFirstSignature(data.requestedByUserId) : null;
  const firstVote: ApprovalVote | null =
    inherited &&
    (await isEligibleApproverInTx(tx, data.scope, policy.approverRoleKeys, inherited.userId))
      ? {
          userId: inherited.userId,
          decision: 'approve',
          at: ctx.now.toISOString(),
          note: `Firma tomada de la propuesta de IA ${inherited.proposalId} (${inherited.toolName})`,
        }
      : null;
  const voteSummary = (requestId: string) => ({
    approvalRequestId: requestId,
    scope: data.scope,
    targetType: data.targetType,
    targetId: data.targetId,
    decision: 'approve' as const,
    approvals: 1,
    rejections: 0,
    requiredApprovals,
    fromProposalId: inherited?.proposalId ?? null,
  });

  if (requiredApprovals <= 0) {
    const approved = await tx.approvalRequest.create({
      data: {
        scope: data.scope,
        targetType: data.targetType,
        targetId: data.targetId,
        amount: data.amount,
        currency: data.currency,
        policyId: policy.id,
        requiredApprovals: 0,
        status: 'approved',
        requestedByUserId: data.requestedByUserId,
        decisions: [],
        expiresAt,
        decidedAt: ctx.now,
        caseId: data.caseId ?? null,
        areaKey,
      },
    });
    ctx.emit(
      OPS_EVENTS.approval.requested,
      { approvalRequestId: approved.id, ...baseEvent, approverUserIds: [] },
      eventOptions(approved.id)
    );
    ctx.emit(
      OPS_EVENTS.approval.approved,
      { approvalRequestId: approved.id, ...baseEvent, auto: true },
      eventOptions(approved.id)
    );
    await runReactions(tx, {
      approvalRequest: approved,
      status: 'approved',
      auto: true,
      decidedByUserId: null,
      ctx,
    });
    return {
      approvalRequest: approved,
      status: 'approved',
      autoApproved: true,
      reused: false,
      approverUserIds: [],
      workItemIds: [],
      firstSignatureByUserId: null,
    };
  }

  // The inherited signature closes a one-signature policy right here: same transaction, same
  // `auto` semantics as a policy auto-approval (the subject is the running command's aggregate).
  if (firstVote && evaluateApproval([firstVote], requiredApprovals).status === 'approved') {
    const approved = await tx.approvalRequest.create({
      data: {
        scope: data.scope,
        targetType: data.targetType,
        targetId: data.targetId,
        amount: data.amount,
        currency: data.currency,
        policyId: policy.id,
        requiredApprovals,
        status: 'approved',
        requestedByUserId: data.requestedByUserId,
        decisions: toOperationalJson([firstVote]),
        expiresAt,
        decidedAt: ctx.now,
        caseId: data.caseId ?? null,
        areaKey,
      },
    });
    ctx.emit(
      OPS_EVENTS.approval.requested,
      { approvalRequestId: approved.id, ...baseEvent, approverUserIds: [] },
      eventOptions(approved.id)
    );
    ctx.emit(OPS_EVENTS.approval.voted, voteSummary(approved.id), eventOptions(approved.id));
    ctx.emit(
      OPS_EVENTS.approval.approved,
      { ...voteSummary(approved.id), auto: true, decidedByUserId: firstVote.userId },
      eventOptions(approved.id)
    );
    await runReactions(tx, {
      approvalRequest: approved,
      status: 'approved',
      auto: true,
      decidedByUserId: firstVote.userId,
      ctx,
    });
    return {
      approvalRequest: approved,
      status: 'approved',
      autoApproved: false,
      reused: false,
      approverUserIds: [],
      workItemIds: [],
      firstSignatureByUserId: firstVote.userId,
    };
  }

  const approvers = await findEligibleApprovers(
    tx,
    data.scope,
    policy.approverRoleKeys,
    data.requestedByUserId
  );
  const stillNeeded = requiredApprovals - (firstVote ? 1 : 0);
  if (approvers.length < stillNeeded) {
    throw new OperationsError(
      'no_approvers',
      `Se necesitan ${stillNeeded} aprobadores distintos y sólo hay ${approvers.length} con permiso para aprobar`,
      {
        details: {
          scope: data.scope,
          required: stillNeeded,
          eligible: approvers.length,
        },
      }
    );
  }

  const request = await tx.approvalRequest.create({
    data: {
      scope: data.scope,
      targetType: data.targetType,
      targetId: data.targetId,
      amount: data.amount,
      currency: data.currency,
      policyId: policy.id,
      requiredApprovals,
      status: 'pending',
      requestedByUserId: data.requestedByUserId,
      decisions: firstVote ? toOperationalJson([firstVote]) : [],
      expiresAt,
      caseId: data.caseId ?? null,
      areaKey,
    },
  });

  const signatures =
    requiredApprovals === 1
      ? '1 firma'
      : `${requiredApprovals} firmas distintas${firstVote ? ' (1 ya registrada)' : ''}`;
  const workItemIds: string[] = [];
  for (const approver of approvers) {
    const item = await ctx.createWorkItem({
      areaKey,
      kind: 'approval',
      title: `Aprobar: ${title}`,
      description: data.description ?? null,
      caseId: data.caseId ?? null,
      objectType: 'approval_request',
      objectId: request.id,
      ownerUserId: approver.id,
      backupUserId: null,
      dueAt: expiresAt,
      notification: {
        category: 'approval_requested',
        title: `Aprobación pendiente: ${title}`,
        body: `Requiere ${signatures}`,
        url: `/app/mywork?approval=${request.id}`,
      },
    });
    workItemIds.push(item.id);
  }
  ctx.emit(
    OPS_EVENTS.approval.requested,
    { approvalRequestId: request.id, ...baseEvent, approverUserIds: approvers.map((a) => a.id) },
    eventOptions(request.id)
  );
  if (firstVote) {
    ctx.emit(OPS_EVENTS.approval.voted, voteSummary(request.id), eventOptions(request.id));
  }
  return {
    approvalRequest: request,
    status: 'pending',
    autoApproved: false,
    reused: false,
    approverUserIds: approvers.map((a) => a.id),
    workItemIds,
    firstSignatureByUserId: firstVote?.userId ?? null,
  };
}

// ---------------------------------------------------------------------------
// approval.decide
// ---------------------------------------------------------------------------

export const APPROVAL_DECIDE_COMMAND = 'approval.decide';

const decideSchema = z.object({
  approvalRequestId: z.string().trim().min(1).max(120),
  decision: z.enum(APPROVAL_DECISIONS),
  note: z.string().trim().max(1000).optional(),
});

export type DecideApprovalInput = z.input<typeof decideSchema>;

export interface ApprovalDecisionData {
  approvalRequestId: string;
  status: ApprovalEvaluation['status'];
  approvals: number;
  rejections: number;
  requiredApprovals: number;
}

registerCommand<z.output<typeof decideSchema>, ApprovalDecisionData>(APPROVAL_DECIDE_COMMAND, {
  schema: decideSchema,
  aggregate: versionedAggregate('approval_request', 'approvalRequest'),
  actorTypes: ['user'],
  audit: 'always',
  async handler(tx, cmd, ctx) {
    const user = ctx.user;
    if (!user)
      throw new OperationsError('unauthenticated', 'Tu sesión expiró; vuelve a iniciar sesión');
    if (cmd.aggregate.id !== cmd.payload.approvalRequestId) {
      throw new OperationsError(
        'invalid_payload',
        'La aprobación no corresponde al registro del comando'
      );
    }
    const request = await tx.approvalRequest.findUnique({
      where: { id: cmd.payload.approvalRequestId },
    });
    if (!request)
      throw new OperationsError('not_found', 'No se encontró la solicitud de aprobación');
    if (request.status !== 'pending') {
      throw new OperationsError('approval_closed', 'Esta solicitud de aprobación ya fue resuelta');
    }
    if (request.expiresAt && request.expiresAt.getTime() <= ctx.now.getTime()) {
      throw new OperationsError('approval_expired', 'Esta solicitud de aprobación ya venció');
    }

    const votes = parseApprovalDecisions(request.decisions);
    const check = checkVote(votes, user.id, request.requestedByUserId);
    if (check === 'self_approval') {
      throw new OperationsError('self_approval', 'No puedes aprobar una solicitud que tú hiciste');
    }
    if (check === 'already_voted') {
      throw new OperationsError('already_voted', 'Ya registraste tu decisión en esta solicitud');
    }
    const policy = request.policyId
      ? await tx.approvalPolicy.findUnique({
          where: { id: request.policyId },
          select: { approverRoleKeys: true },
        })
      : null;
    const scope = request.scope as ApprovalScope;
    if (!isEligibleApprover(user, scope, policy?.approverRoleKeys ?? [])) {
      throw new OperationsError(
        'not_eligible',
        'No tienes permiso para aprobar este tipo de solicitud'
      );
    }

    const nextVotes: ApprovalVote[] = [
      ...votes,
      {
        userId: user.id,
        decision: cmd.payload.decision,
        at: ctx.now.toISOString(),
        note: cmd.payload.note ?? null,
      },
    ];
    const evaluation = evaluateApproval(nextVotes, request.requiredApprovals);
    const final = evaluation.status !== 'pending';
    const updated = await tx.approvalRequest.update({
      where: { id: request.id },
      data: {
        decisions: toOperationalJson(nextVotes),
        status: evaluation.status,
        decidedAt: final ? ctx.now : null,
      },
    });

    const eventOptions = {
      caseId: updated.caseId,
      areaKey: updated.areaKey,
      objectType: 'approval_request',
      objectId: updated.id,
    };
    const openItems = await tx.workItem.findMany({
      where: {
        objectType: 'approval_request',
        objectId: updated.id,
        kind: 'approval',
        status: { in: [...WORK_ITEM_OPEN_STATUSES] },
      },
    });
    for (const item of openItems) {
      const isVoter = item.ownerUserId === user.id;
      if (!isVoter && !final) continue;
      await tx.workItem.update({
        where: { id: item.id },
        data: isVoter
          ? {
              status: 'done',
              completedBy: user.id,
              completedAt: ctx.now,
              result: toOperationalJson({ decision: cmd.payload.decision }),
              version: { increment: 1 },
            }
          : { status: 'cancelled', completedAt: ctx.now, version: { increment: 1 } },
      });
      ctx.emit(
        isVoter ? OPS_EVENTS.workitem.completed : OPS_EVENTS.workitem.cancelled,
        { workItemId: item.id, reason: isVoter ? 'approval_vote' : 'approval_decided' },
        { caseId: item.caseId, areaKey: item.areaKey, objectType: 'work_item', objectId: item.id }
      );
    }

    const summary = {
      approvalRequestId: updated.id,
      scope: updated.scope,
      targetType: updated.targetType,
      targetId: updated.targetId,
      decision: cmd.payload.decision,
      approvals: evaluation.approvals,
      rejections: evaluation.rejections,
      requiredApprovals: updated.requiredApprovals,
    };
    ctx.emit(OPS_EVENTS.approval.voted, summary, eventOptions);
    if (final) {
      const approved = evaluation.status === 'approved';
      ctx.emit(
        approved ? OPS_EVENTS.approval.approved : OPS_EVENTS.approval.rejected,
        { ...summary, auto: false },
        eventOptions
      );
      ctx.notify({
        userId: updated.requestedByUserId,
        category: 'approval_decided',
        type: approved ? 'approval_approved' : 'approval_rejected',
        title: approved
          ? `Aprobada: ${APPROVAL_SCOPE_LABELS[scope]} por ${formatMoney(D(updated.amount), updated.currency)}`
          : `Rechazada: ${APPROVAL_SCOPE_LABELS[scope]} por ${formatMoney(D(updated.amount), updated.currency)}`,
        body: cmd.payload.note ?? null,
        url: updated.caseId ? `/app/operations/cases/${updated.caseId}` : '/app/mywork',
        entityType: 'approval_request',
        entityId: updated.id,
      });
      await runReactions(tx, {
        approvalRequest: updated,
        status: approved ? 'approved' : 'rejected',
        auto: false,
        decidedByUserId: user.id,
        ctx,
      });
    }

    return {
      data: {
        approvalRequestId: updated.id,
        status: evaluation.status,
        approvals: evaluation.approvals,
        rejections: evaluation.rejections,
        requiredApprovals: updated.requiredApprovals,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Expiry (run by the supervisor inside its command)
// ---------------------------------------------------------------------------

export interface ExpireApprovalOutcome {
  approvalRequest: ApprovalRequest | null;
  outcome: 'not_found' | 'closed' | 'not_due' | 'expired';
  cancelledWorkItemIds: string[];
}

/**
 * Marks a pending approval whose `expiresAt` already passed as `expired`:
 * cancels its open approval work items, emits `approval.expired` and tells the
 * requester. Idempotent: an approval that is no longer pending, or not due
 * yet, is left untouched. Runs inside a command whose aggregate is the
 * approval (its version is bumped by the engine, not here). Modules that
 * waited for a decision react to the `approval.expired` event; the
 * `onApprovalDecided` handlers only run for approved or rejected requests.
 */
export async function expireApprovalInTx(
  tx: Prisma.TransactionClient,
  approvalRequestId: string
): Promise<ExpireApprovalOutcome> {
  const ctx = requireCommandContext(tx);
  const request = await tx.approvalRequest.findUnique({ where: { id: approvalRequestId } });
  if (!request) return { approvalRequest: null, outcome: 'not_found', cancelledWorkItemIds: [] };
  if (request.status !== 'pending') {
    return { approvalRequest: request, outcome: 'closed', cancelledWorkItemIds: [] };
  }
  if (!request.expiresAt || request.expiresAt.getTime() > ctx.now.getTime()) {
    return { approvalRequest: request, outcome: 'not_due', cancelledWorkItemIds: [] };
  }

  const updated = await tx.approvalRequest.update({
    where: { id: request.id },
    data: { status: 'expired', decidedAt: ctx.now },
  });
  const openItems = await tx.workItem.findMany({
    where: {
      objectType: 'approval_request',
      objectId: request.id,
      status: { in: [...WORK_ITEM_OPEN_STATUSES] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const cancelledWorkItemIds: string[] = [];
  for (const item of openItems) {
    await tx.workItem.update({
      where: { id: item.id },
      data: { status: 'cancelled', completedAt: ctx.now, version: { increment: 1 } },
    });
    cancelledWorkItemIds.push(item.id);
    ctx.emit(
      OPS_EVENTS.workitem.cancelled,
      { workItemId: item.id, reason: 'approval_expired' },
      { caseId: item.caseId, areaKey: item.areaKey, objectType: 'work_item', objectId: item.id }
    );
  }

  const scope = request.scope as ApprovalScope;
  const approvals = parseApprovalDecisions(request.decisions).filter(
    (vote) => vote.decision === 'approve'
  ).length;
  ctx.emit(
    OPS_EVENTS.approval.expired,
    {
      approvalRequestId: request.id,
      scope: request.scope,
      targetType: request.targetType,
      targetId: request.targetId,
      amount: request.amount.toString(),
      currency: request.currency,
      requiredApprovals: request.requiredApprovals,
      approvals,
      expiresAt: request.expiresAt.toISOString(),
      cancelledWorkItemIds,
    },
    {
      caseId: request.caseId,
      areaKey: request.areaKey,
      objectType: 'approval_request',
      objectId: request.id,
    }
  );
  const label = APPROVAL_SCOPE_LABELS[scope] ?? request.scope;
  ctx.notify({
    userId: request.requestedByUserId,
    category: 'approval_decided',
    type: 'approval_expired',
    title: `Venció sin decisión: ${label} por ${formatMoney(D(request.amount), request.currency)}`,
    body:
      approvals > 0
        ? `Tenía ${approvals} de ${request.requiredApprovals} firmas; vuelve a solicitarla si sigue vigente`
        : 'Nadie la decidió a tiempo; vuelve a solicitarla si sigue vigente',
    url: request.caseId ? `/app/operations/cases/${request.caseId}` : '/app/mywork',
    entityType: 'approval_request',
    entityId: request.id,
  });
  return { approvalRequest: updated, outcome: 'expired', cancelledWorkItemIds };
}

/** Records the actor's vote (`approval.decide`). Repeating `commandId` replays the result. */
export async function decideApproval(
  actor: CurrentUser,
  input: DecideApprovalInput,
  options: { commandId?: string; expectedVersion?: number; now?: Date } = {}
): Promise<CommandResult<ApprovalDecisionData>> {
  return executeCommand<ApprovalDecisionData>(
    {
      commandId: options.commandId ?? randomUUID(),
      type: APPROVAL_DECIDE_COMMAND,
      actor: { type: 'user', id: actor.id },
      aggregate: { type: 'approval_request', id: String(input.approvalRequestId ?? '') },
      expectedVersion: options.expectedVersion,
      payload: input,
    },
    actor,
    { now: options.now }
  );
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

export interface PendingApprovalDTO {
  id: string;
  scope: ApprovalScope;
  scopeLabel: string;
  targetType: string;
  targetId: string;
  amount: string;
  currency: string;
  requiredApprovals: number;
  approvals: number;
  requestedByUserId: string;
  caseId: string | null;
  areaKey: string | null;
  expiresAt: string | null;
  createdAt: string;
  version: number;
  decisions: ApprovalVote[];
}

/** Pending approvals the actor can still decide (eligible, not the requester, no vote yet, not expired). */
export async function listPendingApprovals(
  actor: CurrentUser,
  options: { limit?: number; now?: Date } = {}
): Promise<PendingApprovalDTO[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const now = options.now ?? new Date();
  const rows = await prisma.approvalRequest.findMany({
    where: { status: 'pending', requestedByUserId: { not: actor.id } },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  const policyIds = [
    ...new Set(rows.map((r) => r.policyId).filter((id): id is string => Boolean(id))),
  ];
  const policies = policyIds.length
    ? await prisma.approvalPolicy.findMany({
        where: { id: { in: policyIds } },
        select: { id: true, approverRoleKeys: true },
      })
    : [];
  const roleKeysByPolicy = new Map(policies.map((p) => [p.id, p.approverRoleKeys]));

  const result: PendingApprovalDTO[] = [];
  for (const row of rows) {
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) continue;
    if (!(APPROVAL_SCOPES as readonly string[]).includes(row.scope)) continue;
    const scope = row.scope as ApprovalScope;
    const votes = parseApprovalDecisions(row.decisions);
    if (checkVote(votes, actor.id, row.requestedByUserId) !== 'ok') continue;
    const roleKeys = row.policyId ? (roleKeysByPolicy.get(row.policyId) ?? []) : [];
    if (!isEligibleApprover(actor, scope, roleKeys)) continue;
    result.push({
      id: row.id,
      scope,
      scopeLabel: APPROVAL_SCOPE_LABELS[scope],
      targetType: row.targetType,
      targetId: row.targetId,
      amount: D(row.amount).toString(),
      currency: row.currency,
      requiredApprovals: row.requiredApprovals,
      approvals: evaluateApproval(votes, row.requiredApprovals).approvals,
      requestedByUserId: row.requestedByUserId,
      caseId: row.caseId,
      areaKey: row.areaKey,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      version: row.version,
      decisions: votes,
    });
    if (result.length >= limit) break;
  }
  return result;
}
