import { createHash, randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasPermission, loadActiveCurrentUser, type CurrentUser } from '@/modules/auth/authorization';
import { isKnownPermission } from '@/modules/auth/permissions';
import { FINANCE_AREA_ACT_PERMISSIONS } from '@/modules/finance/permissions';
import { MANUFACTURING_AREA_ACT_PERMISSIONS } from '@/modules/manufacturing/permissions';
import { PURCHASES_ACT_PERMISSIONS } from '@/modules/purchases/permissions';
import { AGENT_BOTS } from '@/modules/agents/identity-catalog';
import { AGENT_TIMEZONE } from '@/modules/agents/templates';
import {
  executeCommand,
  registerCommand,
  versionedAggregate,
  type CommandContext,
  type CommandResult,
} from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { FREE_TEXT_MAX } from '@/modules/operations/request-kinds';
import {
  AREA_KEYS,
  AREA_LABELS,
  AREA_REQUEST_KINDS,
  AREA_REQUEST_OPEN_STATUSES,
  CASE_OPEN_STATUSES,
  INCIDENT_KINDS,
  INCIDENT_SEVERITIES,
  PRIORITIES,
  WORK_ITEM_OPEN_STATUSES,
  isAreaKey,
  type ActorType,
  type AreaKey,
  type OperationsActor,
} from '@/modules/operations/types';
import { registerTool, type ToolDefinition, type ToolExecutionContext } from './registry';

/**
 * Shared kit of the operations tools (plan 5.5): `agents-tools.ts`,
 * `mywork-tools.ts` and `control-tower-tools.ts`.
 *
 * - Scope of the actor: a bot is an AI identity (`CurrentUser.isBot`, set only by
 *   `buildBotActor`) with its fixed system role (`agent_<area>` / `agent_admin`); a
 *   person holding such a role is still a person. Bots only act inside the area
 *   they cover; `ctx.agentAreaKey` (set by the orchestrator in agent turns and by
 *   `approveProposal` when a person executes an agent proposal) must agree.
 * - Mention turns (`ctx.agentOnBehalfOfUserId`): the bot acts only where the person
 *   who mentioned it may act, and reads only the room's case or cases that person
 *   may open. A bot never lends its permissions.
 * - "operations.<área>.act" does not exist as a permission family (plan 7.2):
 *   acting for an area means operations.manage / super_admin, one of the area's
 *   module ACTION permissions (never a `.view`; filtered against the code-first
 *   registry, so keys of modules not built yet stay inert), or being the area lead,
 *   responsible or backup. Membership of the area channel is for communication
 *   only: it never grants authority to act.
 * - Thin commands over the core primitives that had no command of their own
 *   (`ctx.createAreaRequest`, `openOrReopenIncident`, `ctx.createWorkItem`,
 *   `reassignWorkItemInTx`, `requestApproval`). They authorize by themselves
 *   (never trusting the payload), because the command registry is global.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Pages where these tools make sense (informative for built-in tools). */
export const OPERATIONS_TOOL_CONTEXT_TAGS = [
  '/app/operations',
  '/app/areas',
  '/app/mywork',
  '/app/admin/control-tower',
];

export const AI_OPS_COMMANDS = {
  createRequest: 'ai_ops.request.create',
  openIncident: 'ai_ops.incident.open',
  requestVerification: 'ai_ops.stock.request_verification',
  assignWorkItem: 'ai_ops.workitem.assign',
} as const;

/** Max case notes an actor posts per case per local day through `postCaseNote`. */
export const CASE_NOTES_PER_DAY = 3;

/**
 * Module permissions that let a person act for an area (plan 7.2 mapping). Each
 * domain module owns its own list; candidates of modules that do not exist yet
 * are filtered by the registry.
 */
export const AREA_ACT_PERMISSION_CANDIDATES: Readonly<Record<AreaKey, readonly string[]>> = {
  ventas: ['crm.manage', 'crm.create_sales_order'],
  compras: [...PURCHASES_ACT_PERMISSIONS],
  inventario: ['inventory.count', 'inventory.reserve', 'inventory.adjust', 'inventory.manage'],
  manufactura: [...MANUFACTURING_AREA_ACT_PERMISSIONS],
  logistica: ['logistics.dispatch', 'logistics.manage_fleet'],
  contabilidad: [...FINANCE_AREA_ACT_PERMISSIONS],
  administracion: ['operations.admin'],
};

// ---------------------------------------------------------------------------
// Errors and small pure helpers
// ---------------------------------------------------------------------------

/** Spanish error raised by an operations tool; the registry returns its message to the model. */
export class OperationsToolError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'invalid_request'
  ) {
    super(message);
    this.name = 'OperationsToolError';
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((key) => obj[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',')}}`;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Short stable hash (dedupe keys). */
export function shortHash(text: string, length = 16): string {
  return sha(text).slice(0, length);
}

/** Registers an operations tool with the common defaults (category, enablement, context tags). */
export function registerOperationsTool(
  def: Omit<ToolDefinition, 'category' | 'enabledByDefault'> & Partial<Pick<ToolDefinition, 'enabledByDefault'>>
): void {
  registerTool({
    category: 'operations',
    enabledByDefault: true,
    contextTags: OPERATIONS_TOOL_CONTEXT_TAGS,
    ...def,
  });
}

/** YYYY-MM-DD of `now` in the agents time zone. */
export function localDayKey(now: Date, tz: string = AGENT_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function timeZoneOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Instant when the local day of `now` started in the agents time zone. */
export function localDayStart(now: Date, tz: string = AGENT_TIMEZONE): Date {
  const [year, month, day] = localDayKey(now, tz).split('-').map(Number);
  const guess = Date.UTC(year, month - 1, day);
  return new Date(guess - timeZoneOffsetMs(new Date(guess), tz));
}

/** YYYY-MM-DD `days` after `now` (local day). */
export function localDayPlus(now: Date, days: number, tz: string = AGENT_TIMEZONE): string {
  return localDayKey(new Date(now.getTime() + days * 86_400_000), tz);
}

export function formatMoney(amount: number | string, currency = 'MXN'): string {
  const value = Number(amount);
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function truncateText(text: string | null | undefined, max: number): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function areaName(areaKey: string | null | undefined): string {
  return areaKey && isAreaKey(areaKey) ? AREA_LABELS[areaKey] : String(areaKey ?? '');
}

// ---------------------------------------------------------------------------
// Actor scope
// ---------------------------------------------------------------------------

/** Area identity of the actor: the covered area of a bot, `'admin'` for the administrator bot, null for people. */
export type AgentScopeKey = AreaKey | 'admin';

export function botScopeOf(actor: Pick<CurrentUser, 'roleKeys' | 'isBot'>): AgentScopeKey | null {
  if (actor.isBot !== true) return null;
  const def = AGENT_BOTS.find((bot) => actor.roleKeys.includes(bot.roleKey));
  if (!def) return null;
  return def.kind === 'admin' ? 'admin' : def.coversAreaKey;
}

export function isBotActor(actor: Pick<CurrentUser, 'roleKeys' | 'isBot'>): boolean {
  return botScopeOf(actor) !== null;
}

/** `'admin'` → administracion; area keys unchanged; anything else → null. */
export function areaOfScope(scope: string | null | undefined): AreaKey | null {
  if (!scope) return null;
  if (scope === 'admin') return 'administracion';
  return isAreaKey(scope) ? scope : null;
}

/** Area the actor acts for by default: a bot's area; null for people. */
export function defaultActingArea(actor: Pick<CurrentUser, 'roleKeys' | 'isBot'>): AreaKey | null {
  return areaOfScope(botScopeOf(actor));
}

/** Like `hasPermission`, but false (never a throw) for keys not in the registry. */
export function actorHas(actor: CurrentUser, permissionKey: string): boolean {
  if (!isKnownPermission(permissionKey)) return false;
  return hasPermission(actor, permissionKey);
}

export function areaActPermissions(areaKey: AreaKey): string[] {
  return AREA_ACT_PERMISSION_CANDIDATES[areaKey].filter((key) => isKnownPermission(key));
}

function agentLabel(scope: AgentScopeKey): string {
  return scope === 'admin' ? 'IA administradora' : `IA de ${AREA_LABELS[scope]}`;
}

type ScopeContext = Pick<ToolExecutionContext, 'agentAreaKey' | 'agentOnBehalfOfUserId' | 'agentCaseId'> | undefined;

/**
 * Bot scope for actions (pure): a bot acts only in its own area (the
 * administrator only in Administración) and must agree with `ctx.agentAreaKey`;
 * a person executing an approved agent proposal is bound to the proposal's area.
 * Returns the Spanish reason or null.
 */
export function checkActingScope(actor: Pick<CurrentUser, 'roleKeys' | 'isBot'>, areaKey: AreaKey, ctx?: ScopeContext): string | null {
  const bot = botScopeOf(actor);
  const scoped = ctx?.agentAreaKey;
  if (bot) {
    const botArea = areaOfScope(bot) as AreaKey;
    if (scoped !== undefined && areaOfScope(scoped) !== botArea) {
      return 'La identidad del agente no coincide con el área de este turno';
    }
    if (areaKey !== botArea) {
      return `La ${agentLabel(bot)} sólo puede actuar en ${AREA_LABELS[botArea]}; esto corresponde a ${AREA_LABELS[areaKey]}`;
    }
    return null;
  }
  if (scoped !== undefined) {
    const scopedArea = areaOfScope(scoped);
    if (!scopedArea) return 'El área de la propuesta aprobada es inválida';
    if (scopedArea !== areaKey) {
      return `Esta acción la propuso la IA de ${AREA_LABELS[scopedArea]} y no puede actuar en ${AREA_LABELS[areaKey]}`;
    }
  }
  return null;
}

/** Bot scope for area-scoped readings (pure): coordinators read their area; the administrator reads all. */
export function checkReadingScope(actor: Pick<CurrentUser, 'roleKeys' | 'isBot'>, areaKey: AreaKey, ctx?: ScopeContext): string | null {
  const bot = botScopeOf(actor);
  if (!bot) return null;
  if (ctx?.agentAreaKey !== undefined && areaOfScope(ctx.agentAreaKey) !== areaOfScope(bot)) {
    return 'La identidad del agente no coincide con el área de este turno';
  }
  if (bot === 'admin' || bot === areaKey) return null;
  return `La ${agentLabel(bot)} sólo consulta el trabajo de ${AREA_LABELS[bot]}`;
}

/** Lead, responsible or backup of the area: the people with authority to act for it. */
export async function isAreaPerson(db: Prisma.TransactionClient, userId: string, areaKey: AreaKey): Promise<boolean> {
  if (!userId) return false;
  const area = await db.area.findUnique({
    where: { key: areaKey },
    select: { leadUserId: true, responsibleArea: true },
  });
  if (area?.leadUserId === userId) return true;
  const responsible = await db.responsible.findUnique({
    where: { area: area?.responsibleArea || areaKey },
    select: { userId: true, backupUserId: true, active: true },
  });
  return Boolean(responsible?.active && (responsible.userId === userId || responsible.backupUserId === userId));
}

/**
 * People OF the area (lead, responsible, backup or active member of the area channel): who may
 * receive the area's work. Channel membership never grants authority to act (see `isAreaPerson`).
 */
export async function isAreaMember(db: Prisma.TransactionClient, userId: string, areaKey: AreaKey): Promise<boolean> {
  if (!userId) return false;
  if (await isAreaPerson(db, userId, areaKey)) return true;
  const area = await db.area.findUnique({ where: { key: areaKey }, select: { chatChannelId: true } });
  if (!area?.chatChannelId) return false;
  const member = await db.internalChatMember.findFirst({
    where: { channelId: area.chatChannelId, userId, leftAt: null },
    select: { id: true },
  });
  return Boolean(member);
}

/** The active human who mentioned the bot in this turn, or null when the turn is not a mention. */
async function mentionPerson(ctx: ScopeContext): Promise<CurrentUser | 'missing' | null> {
  const userId = ctx?.agentOnBehalfOfUserId;
  if (!userId) return null;
  const person = await loadActiveCurrentUser(userId);
  return person && person.isBot !== true ? person : 'missing';
}

/**
 * Whether the actor may act for `areaKey` ("operations.<área>.act"). Returns the
 * Spanish reason when not allowed, null when allowed. Bots are limited to their
 * area (their own permissions are enforced by the core commands).
 */
export async function canActForArea(
  actor: CurrentUser,
  areaKey: AreaKey,
  ctx?: ScopeContext,
  db: Prisma.TransactionClient = prisma
): Promise<string | null> {
  const scopeError = checkActingScope(actor, areaKey, ctx);
  if (scopeError) return scopeError;
  if (isBotActor(actor)) {
    // A mention turn acts with the limits of the person who wrote the mention.
    const person = await mentionPerson(ctx);
    if (person === 'missing') return 'Quien mencionó a la IA ya no está activo';
    if (person) {
      const personReason = await canActForArea(person, areaKey, undefined, db);
      if (personReason) return `Quien mencionó a la IA no puede actuar en nombre de ${AREA_LABELS[areaKey]}`;
    }
    return null;
  }
  if (actor.isSuperAdmin || actorHas(actor, 'operations.manage')) return null;
  if (areaActPermissions(areaKey).some((key) => actorHas(actor, key))) return null;
  if (await isAreaPerson(db, actor.id, areaKey)) return null;
  return `No puedes actuar en nombre de ${AREA_LABELS[areaKey]}: necesitas ser responsable del área, gestor de operaciones o tener los permisos del área`;
}

export async function assertCanActForArea(actor: CurrentUser, areaKey: AreaKey, ctx?: ScopeContext): Promise<void> {
  const reason = await canActForArea(actor, areaKey, ctx);
  if (reason) throw new OperationsToolError(reason, 'forbidden');
}

export function assertActingScope(actor: CurrentUser, areaKey: AreaKey, ctx?: ScopeContext): void {
  const reason = checkActingScope(actor, areaKey, ctx);
  if (reason) throw new OperationsToolError(reason, 'forbidden');
}

export function assertReadingScope(actor: CurrentUser, areaKey: AreaKey, ctx?: ScopeContext): void {
  const reason = checkReadingScope(actor, areaKey, ctx);
  if (reason) throw new OperationsToolError(reason, 'forbidden');
}

/**
 * Bots only read cases their area takes part in (the administrator reads every case). In a
 * mention turn the case must also be the room's own case or one the mentioning person may open.
 */
export async function assertCaseInAgentScope(actor: CurrentUser, caseId: string, ctx?: ScopeContext): Promise<void> {
  const bot = botScopeOf(actor);
  if (!bot) return;
  if (ctx?.agentAreaKey !== undefined && areaOfScope(ctx.agentAreaKey) !== areaOfScope(bot)) {
    throw new OperationsToolError('La identidad del agente no coincide con el área de este turno', 'forbidden');
  }
  const person = await mentionPerson(ctx);
  if (person === 'missing') throw new OperationsToolError('Quien mencionó a la IA ya no está activo', 'forbidden');
  if (person && caseId !== ctx?.agentCaseId) {
    const { authorizeOperationsChannel } = await import('@/modules/operations/events-service');
    if (!(await authorizeOperationsChannel(person, 'case', caseId))) {
      throw new OperationsToolError('Quien mencionó a la IA no tiene acceso a ese expediente', 'forbidden');
    }
  }
  if (bot === 'admin') return;
  const { involvedAreasOfCase } = await import('@/modules/agents/chat-bridge');
  const involved = await involvedAreasOfCase(caseId);
  if (!involved.includes(bot)) {
    throw new OperationsToolError(`El expediente no involucra a ${AREA_LABELS[bot]}`, 'forbidden');
  }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export interface CaseRef {
  id: string;
  caseNumber: string;
  status: string;
  phase: string;
  priority: string;
  salesOrderNumber: string | null;
  customerName: string | null;
  promisedAt: Date | null;
  lastActivityAt: Date;
  chatChannelId: string | null;
  ownerUserId: string;
  locationId: string | null;
  deliveryMethod: string | null;
}

const CASE_REF_SELECT = {
  id: true,
  caseNumber: true,
  status: true,
  phase: true,
  priority: true,
  salesOrderNumber: true,
  customerName: true,
  promisedAt: true,
  lastActivityAt: true,
  chatChannelId: true,
  ownerUserId: true,
  locationId: true,
  deliveryMethod: true,
} as const;

/** Case by id, number (`EXP-123`) or sales order number (`OV-23131`). */
export async function resolveCase(ref: string): Promise<CaseRef> {
  const value = String(ref ?? '').trim();
  if (!value) throw new OperationsToolError('Indica el expediente', 'invalid_args');
  let row: CaseRef | null;
  if (/^exp-\d+$/i.test(value)) {
    row = await prisma.operationalCase.findUnique({ where: { caseNumber: value.toUpperCase() }, select: CASE_REF_SELECT });
  } else if (/^ov-/i.test(value)) {
    row = await prisma.operationalCase.findFirst({
      where: { salesOrderNumber: { equals: value, mode: 'insensitive' } },
      orderBy: { openedAt: 'desc' },
      select: CASE_REF_SELECT,
    });
  } else {
    row = await prisma.operationalCase.findUnique({ where: { id: value }, select: CASE_REF_SELECT });
  }
  if (!row) throw new OperationsToolError(`No se encontró el expediente ${truncateText(value, 60)}`, 'not_found');
  return row;
}

export function isOpenCaseStatus(status: string): boolean {
  return (CASE_OPEN_STATUSES as readonly string[]).includes(status);
}

export function isOpenRequestStatus(status: string): boolean {
  return (AREA_REQUEST_OPEN_STATUSES as readonly string[]).includes(status);
}

/** User id from an id or `@username` (active people only). */
export async function resolveUserRef(ref: string): Promise<{ id: string; name: string }> {
  const value = String(ref ?? '').trim();
  const username = value.startsWith('@') ? value.slice(1) : null;
  const user = username
    ? await prisma.user.findUnique({ where: { username }, select: { id: true, name: true, isActive: true, isBot: true } })
    : await prisma.user.findUnique({ where: { id: value }, select: { id: true, name: true, isActive: true, isBot: true } });
  if (!user || !user.isActive || user.isBot) {
    throw new OperationsToolError(`No encontré a una persona activa con "${truncateText(value, 60)}"`, 'not_found');
  }
  return { id: user.id, name: user.name };
}

export async function userNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (unique.length === 0) return new Map();
  const rows = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(rows.map((row) => [row.id, row.name]));
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

export function commandActorOf(actor: CurrentUser): OperationsActor {
  return { type: isBotActor(actor) ? 'ai' : 'user', id: actor.id };
}

type IdContext = Pick<ToolExecutionContext, 'approvedProposalId'> | undefined;

/**
 * Creations: the same actor asking the same thing on the same local day replays
 * the stored result instead of creating a duplicate. An approved proposal runs
 * once under its own id.
 */
export function creationCommandId(tool: string, actorId: string, parts: unknown, ctx?: IdContext, now: Date = new Date(), step?: string): string {
  const suffix = step ? `:${step}` : '';
  if (ctx?.approvedProposalId) return `proposal:${ctx.approvedProposalId}:${tool}${suffix}`.slice(0, 160);
  const digest = sha(`${actorId}|${localDayKey(now)}|${stableStringify(parts)}`).slice(0, 40);
  return `ai:${tool}:${digest}${suffix}`.slice(0, 160);
}

/** Transitions may legitimately repeat, so they get a fresh id (or the proposal's). */
export function transitionCommandId(tool: string, ctx?: IdContext, step?: string): string {
  const suffix = step ? `:${step}` : '';
  if (ctx?.approvedProposalId) return `proposal:${ctx.approvedProposalId}:${tool}${suffix}`.slice(0, 160);
  return randomUUID();
}

/** Loads every operational command (inventory, logistics, core) before executing one by type. */
export async function loadOperationsCommands(): Promise<void> {
  await import('@/modules/operations/register-commands');
}

/** Throws the Spanish message of a rejected command; returns the result otherwise. */
export function unwrapCommand<D>(result: CommandResult<D>): CommandResult<D> {
  if (result.status === 'rejected') {
    throw new OperationsToolError(result.message ?? 'La operación fue rechazada', result.errorCode ?? 'rejected');
  }
  return result;
}

export interface RunCommandInput {
  commandId: string;
  type: string;
  aggregate: { type: string; id: string };
  payload: unknown;
  expectedVersion?: number;
}

/** Executes an operational command as the tool's actor (`ai` for bots, `user` for people). */
export async function runOperationsCommand<D>(actor: CurrentUser, input: RunCommandInput): Promise<CommandResult<D>> {
  await loadOperationsCommands();
  const result = await executeCommand<D>(
    {
      commandId: input.commandId,
      type: input.type,
      actor: commandActorOf(actor),
      aggregate: input.aggregate,
      expectedVersion: input.expectedVersion,
      payload: input.payload,
    },
    actor
  );
  return unwrapCommand(result);
}

// ---------------------------------------------------------------------------
// Thin commands (authorize by themselves)
// ---------------------------------------------------------------------------

const HUMAN_OR_AI: readonly ActorType[] = ['user', 'ai'];

const idText = z.string().trim().min(1).max(120);
const isoInstant = z
  .string()
  .trim()
  .min(10)
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Fecha inválida (usa formato ISO)');
const scopeText = z.string().trim().max(40).nullish();

/** Checks, inside the command, that the session may act for `areaKey` (people and registered bots only). */
export async function assertCommandMayActForArea(
  tx: Prisma.TransactionClient,
  ctx: Pick<CommandContext, 'actor' | 'user'>,
  areaKey: AreaKey,
  scopeAreaKey?: string | null
): Promise<void> {
  const user = ctx.user;
  if (!user || (ctx.actor.type !== 'user' && ctx.actor.type !== 'ai')) {
    throw new OperationsError('forbidden', 'Esta acción la hace una persona o una identidad de IA registrada');
  }
  const row = await tx.user.findUnique({ where: { id: user.id }, select: { isActive: true, isBot: true } });
  if (!row?.isActive) throw new OperationsError('forbidden', 'Tu usuario no está activo');
  const bot = isBotActor(user);
  if (ctx.actor.type === 'ai' && !(row.isBot && bot)) {
    throw new OperationsError('forbidden', 'Sólo una identidad de IA registrada puede actuar como IA');
  }
  if (ctx.actor.type === 'user' && (row.isBot || bot)) {
    throw new OperationsError('forbidden', 'Una identidad de IA no puede actuar como persona');
  }
  const reason = await canActForArea(user, areaKey, scopeAreaKey ? { agentAreaKey: scopeAreaKey } : undefined, tx);
  if (reason) throw new OperationsError('forbidden', reason);
}

async function assertOpenCase(tx: Prisma.TransactionClient, caseId: string): Promise<{ id: string; caseNumber: string }> {
  const opCase = await tx.operationalCase.findUnique({ where: { id: caseId }, select: { id: true, status: true, caseNumber: true } });
  if (!opCase) throw new OperationsError('not_found', 'No se encontró el expediente');
  if (!isOpenCaseStatus(opCase.status)) {
    throw new OperationsError('invalid_state', `El expediente ${opCase.caseNumber} ya está cerrado o cancelado`);
  }
  return opCase;
}

export const createRequestCommandSchema = z.object({
  caseId: idText,
  fromAreaKey: z.enum(AREA_KEYS),
  toAreaKey: z.enum(AREA_KEYS),
  kind: z.enum(AREA_REQUEST_KINDS),
  title: z.string().trim().min(1).max(200),
  payload: z.record(z.unknown()),
  freeText: z.string().max(FREE_TEXT_MAX).nullish(),
  priority: z.enum(PRIORITIES).nullish(),
  blocksDelivery: z.boolean().nullish(),
  dueAt: isoInstant.nullish(),
  objectType: z.string().trim().min(1).max(60).nullish(),
  objectId: idText.nullish(),
  scopeAreaKey: scopeText,
  /** AI requests: the human who caused the turn (mention sender, human actor of the event). */
  causedByUserId: idText.nullish(),
});
export type CreateRequestCommandInput = z.input<typeof createRequestCommandSchema>;

/** `ObjectRelation.relation` from an AI-created request to the human who caused it. */
export const CAUSED_BY_RELATION = 'caused_by';

export interface CreateRequestCommandData {
  requestId: string;
  workItemId: string;
  status: string;
  kind: string;
  fromAreaKey: string;
  toAreaKey: string;
  ownerUserId: string;
  backupUserId: string | null;
  dueAt: string;
  priority: string;
  blocksDelivery: boolean;
}

registerCommand<z.output<typeof createRequestCommandSchema>, CreateRequestCommandData>(AI_OPS_COMMANDS.createRequest, {
  schema: createRequestCommandSchema,
  aggregate: 'none',
  actorTypes: HUMAN_OR_AI,
  async handler(tx, cmd, ctx) {
    const p = cmd.payload;
    await assertCommandMayActForArea(tx, ctx, p.fromAreaKey, p.scopeAreaKey);
    await assertOpenCase(tx, p.caseId);
    const dueAt = p.dueAt ? new Date(p.dueAt) : undefined;
    if (dueAt && dueAt.getTime() <= ctx.now.getTime()) {
      throw new OperationsError('invalid_payload', 'La fecha límite de la solicitud debe ser futura');
    }
    const { request, workItem } = await ctx.createAreaRequest({
      caseId: p.caseId,
      fromAreaKey: p.fromAreaKey,
      toAreaKey: p.toAreaKey,
      kind: p.kind,
      objectType: p.objectType ?? 'operational_case',
      objectId: p.objectId ?? p.caseId,
      title: p.title,
      payload: p.payload,
      freeText: p.freeText ?? null,
      priority: p.priority ?? undefined,
      blocksDelivery: p.blocksDelivery ?? undefined,
      dueAt,
    });
    // An AI request keeps who caused it, so that person can never also sign what they asked for.
    if (ctx.actor.type === 'ai' && p.causedByUserId) {
      const causer = await tx.user.findUnique({ where: { id: p.causedByUserId }, select: { isActive: true, isBot: true } });
      if (causer?.isActive && !causer.isBot) {
        await ctx.relate({ type: 'area_request', id: request.id }, { type: 'user', id: p.causedByUserId }, CAUSED_BY_RELATION);
      }
    }
    return {
      data: {
        requestId: request.id,
        workItemId: workItem.id,
        status: request.status,
        kind: request.kind,
        fromAreaKey: request.fromAreaKey,
        toAreaKey: request.toAreaKey,
        ownerUserId: request.ownerUserId,
        backupUserId: request.backupUserId,
        dueAt: request.dueAt.toISOString(),
        priority: request.priority,
        blocksDelivery: request.blocksDelivery,
      },
      aggregateVersion: request.version,
    };
  },
});

export const openIncidentCommandSchema = z.object({
  areaKey: z.enum(AREA_KEYS),
  kind: z.enum(INCIDENT_KINDS),
  severity: z.enum(INCIDENT_SEVERITIES),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(1000).nullish(),
  caseId: idText.nullish(),
  relatedRequestId: idText.nullish(),
  dedupeKey: z.string().trim().min(1).max(300),
  scopeAreaKey: scopeText,
});
export type OpenIncidentCommandInput = z.input<typeof openIncidentCommandSchema>;

export interface OpenIncidentCommandData {
  incidentId: string;
  created: boolean;
  reopened: boolean;
  status: string;
  severity: string;
  ownerUserId: string | null;
}

registerCommand<z.output<typeof openIncidentCommandSchema>, OpenIncidentCommandData>(AI_OPS_COMMANDS.openIncident, {
  schema: openIncidentCommandSchema,
  aggregate: 'none',
  actorTypes: HUMAN_OR_AI,
  async handler(tx, cmd, ctx) {
    const p = cmd.payload;
    await assertCommandMayActForArea(tx, ctx, p.areaKey, p.scopeAreaKey);
    if (p.caseId) {
      const exists = await tx.operationalCase.findUnique({ where: { id: p.caseId }, select: { id: true } });
      if (!exists) throw new OperationsError('not_found', 'No se encontró el expediente');
    }
    const { openOrReopenIncident } = await import('@/modules/operations/incidents-service');
    const outcome = await openOrReopenIncident(tx, {
      kind: p.kind,
      areaKey: p.areaKey,
      title: p.title,
      dedupeKey: p.dedupeKey,
      severity: p.severity,
      caseId: p.caseId ?? null,
      detail: {
        source: 'ai_tool',
        description: p.description ?? null,
        relatedRequestId: p.relatedRequestId ?? null,
        reportedBy: { type: ctx.actor.type, id: ctx.actor.id },
      },
    });
    return {
      data: {
        incidentId: outcome.incident.id,
        created: outcome.created,
        reopened: outcome.reopened,
        status: outcome.incident.status,
        severity: outcome.incident.severity,
        ownerUserId: outcome.incident.ownerUserId,
      },
      aggregateVersion: outcome.incident.version,
    };
  },
});

export const requestVerificationCommandSchema = z.object({
  caseId: idText,
  demandId: idText,
  fromAreaKey: z.enum(AREA_KEYS),
  reason: z.string().trim().max(500).nullish(),
  scopeAreaKey: scopeText,
});
export type RequestVerificationCommandInput = z.input<typeof requestVerificationCommandSchema>;

export interface RequestVerificationCommandData {
  workItemId: string;
  created: boolean;
  ownerUserId: string;
  dueAt: string;
}

registerCommand<z.output<typeof requestVerificationCommandSchema>, RequestVerificationCommandData>(
  AI_OPS_COMMANDS.requestVerification,
  {
    schema: requestVerificationCommandSchema,
    aggregate: 'none',
    actorTypes: HUMAN_OR_AI,
    async handler(tx, cmd, ctx) {
      const p = cmd.payload;
      await assertCommandMayActForArea(tx, ctx, p.fromAreaKey, p.scopeAreaKey);
      await assertOpenCase(tx, p.caseId);
      const demand = await tx.caseDemand.findUnique({ where: { id: p.demandId } });
      if (!demand || demand.caseId !== p.caseId) {
        throw new OperationsError('not_found', 'No se encontró la partida en este expediente');
      }
      if (demand.status === 'fulfilled' || demand.status === 'cancelled') {
        throw new OperationsError('invalid_state', 'La partida ya está surtida o cancelada');
      }
      const existing = await tx.workItem.findFirst({
        where: {
          areaKey: 'inventario',
          kind: 'verification',
          objectType: 'case_demand',
          objectId: demand.id,
          status: { in: [...WORK_ITEM_OPEN_STATUSES] },
        },
        select: { id: true, ownerUserId: true, dueAt: true },
      });
      if (existing) {
        return {
          data: { workItemId: existing.id, created: false, ownerUserId: existing.ownerUserId, dueAt: existing.dueAt.toISOString() },
        };
      }
      const item = await ctx.createWorkItem({
        areaKey: 'inventario',
        kind: 'verification',
        title: truncateText(`Verificar existencia: ${demand.name}`, 200),
        description: [`Solicitado por ${AREA_LABELS[p.fromAreaKey]}`, p.reason ?? null].filter(Boolean).join(' · '),
        caseId: demand.caseId,
        objectType: 'case_demand',
        objectId: demand.id,
        requiredEvidence: ['count'],
      });
      return {
        data: { workItemId: item.id, created: true, ownerUserId: item.ownerUserId, dueAt: item.dueAt.toISOString() },
        aggregateVersion: item.version,
      };
    },
  }
);

export const assignWorkItemCommandSchema = z.object({
  workItemId: idText,
  ownerUserId: idText,
  backupUserId: idText.nullish(),
  dueAt: isoInstant.nullish(),
  reason: z.string().trim().max(500).nullish(),
  scopeAreaKey: scopeText,
});
export type AssignWorkItemCommandInput = z.input<typeof assignWorkItemCommandSchema>;

export interface AssignWorkItemCommandData {
  workItemId: string;
  status: string;
  ownerUserId: string;
  backupUserId: string | null;
  dueAt: string;
}

/** Area coordinators reassign work of their own area to people of that area (plan 5.5 "assignWorkItem (propia área)"). */
registerCommand<z.output<typeof assignWorkItemCommandSchema>, AssignWorkItemCommandData>(AI_OPS_COMMANDS.assignWorkItem, {
  schema: assignWorkItemCommandSchema,
  aggregate: versionedAggregate('work_item', 'workItem'),
  actorTypes: ['ai'],
  async handler(tx, cmd, ctx) {
    const p = cmd.payload;
    if (cmd.aggregate.id !== p.workItemId) {
      throw new OperationsError('invalid_payload', 'El trabajo no corresponde al registro del comando');
    }
    const { loadWorkItem, reassignWorkItemInTx } = await import('@/modules/operations/work-items-service');
    const item = await loadWorkItem(tx, p.workItemId);
    if (!isAreaKey(item.areaKey)) throw new OperationsError('invalid_state', 'El trabajo tiene un área inválida');
    await assertCommandMayActForArea(tx, ctx, item.areaKey, p.scopeAreaKey);
    for (const userId of [p.ownerUserId, p.backupUserId]) {
      if (userId && !(await isAreaMember(tx, userId, item.areaKey))) {
        throw new OperationsError('forbidden', `Sólo puedes asignar el trabajo a personas de ${AREA_LABELS[item.areaKey]}`);
      }
    }
    const updated = await reassignWorkItemInTx(
      tx,
      item,
      {
        ownerUserId: p.ownerUserId,
        backupUserId: p.backupUserId === undefined ? undefined : p.backupUserId,
        dueAt: p.dueAt ? new Date(p.dueAt) : null,
        reason: p.reason ?? null,
      },
      { aggregate: true }
    );
    return {
      data: {
        workItemId: updated.id,
        status: updated.status,
        ownerUserId: updated.ownerUserId,
        backupUserId: updated.backupUserId,
        dueAt: updated.dueAt.toISOString(),
      },
    };
  },
});
