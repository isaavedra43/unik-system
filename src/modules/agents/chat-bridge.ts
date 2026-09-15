import type { AgentIdentity } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { ChatMessageDTO, ChatMessageMeta } from '@/modules/chat/chat-events';
import {
  createAreaChannel,
  createCaseRoom,
  sendSystemMessage,
  syncChannelMembers,
  type OperationsChannelResult,
} from '@/modules/chat/chat-service';
import { AREA_LABELS, isAreaKey, type AreaKey } from '@/modules/operations/types';
import {
  ADMIN_AGENT_KEY,
  agentBotFor,
  agentKeyForArea,
  isAgentKey,
  type AgentKey,
} from './identity-catalog';
import { ensureAgentIdentities } from './identities';
import { areaMemberPermissionKeys } from './permissions';

/**
 * Bridge between the agents layer and the internal chat (plan 5.7). Channels of
 * type `area` and `case` are created ONLY here, through the idempotent chat
 * service functions (which own and protect `Area.chatChannelId` /
 * `OperationalCase.chatChannelId`, both @unique: conditional updateMany, the
 * loser of a race discards its channel and adopts the winner's).
 *
 * - Area channel: people holding the area's module permissions, its responsible
 *   and backup, the area lead, the area bot; created by the admin bot.
 * - Case room: responsible and backup of every involved area (lead when there is
 *   no responsible), their bots and the case owner (the salesperson).
 * - Bots already in a channel stay (only people follow permission changes).
 * - `postAsAgent` posts through `sendSystemMessage`; template kinds do not fan
 *   out chat notifications (the dispatcher notifies the responsible directly).
 */

export class AgentBridgeError extends Error {
  constructor(
    public readonly code: 'agents_not_seeded' | 'unknown_agent' | 'not_found' | 'channel_not_operational' | 'empty_message',
    message: string
  ) {
    super(message);
    this.name = 'AgentBridgeError';
  }
}

export interface EnsureChannelOptions {
  /** Bots that must be members (e.g. an agent about to post). */
  extraAgentKeys?: AgentKey[];
}

const MEMBER_QUERY_LIMIT = 500;
const CASE_ROWS_LIMIT = 500;
/** Step states that mean the area really takes part in the case (alternative paths stay pending/skipped). */
const INVOLVED_STEP_STATUSES = ['ready', 'active', 'waiting', 'done', 'failed'];

const warn = (event: string, extra: Record<string, unknown> = {}) =>
  console.warn(JSON.stringify({ component: 'agents-chat-bridge', event, ...extra }));

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

async function identitiesByKey(keys: readonly AgentKey[]): Promise<Map<string, AgentIdentity>> {
  const load = async () =>
    prisma.agentIdentity.findMany({ where: { key: { in: [...new Set(keys)] } } });
  let rows = await load();
  if (rows.length < new Set(keys).size) {
    // First use before the startup seed finished: seed (idempotent) and retry once.
    await ensureAgentIdentities();
    rows = await load();
  }
  return new Map(rows.map((row) => [row.key, row]));
}

async function requireIdentity(agentKey: AgentKey): Promise<AgentIdentity> {
  const identity = (await identitiesByKey([agentKey])).get(agentKey);
  if (!identity) {
    throw new AgentBridgeError('agents_not_seeded', `No existe la identidad ${agentKey}; revisa el arranque de agentes`);
  }
  return identity;
}

async function adminBotUserId(): Promise<string> {
  return (await requireIdentity(ADMIN_AGENT_KEY)).botUserId;
}

/** Bots currently active in a channel (kept on every sync). */
async function currentBotMembers(channelId: string | null): Promise<string[]> {
  if (!channelId) return [];
  const members = await prisma.internalChatMember.findMany({
    where: { channelId, leftAt: null },
    select: { userId: true },
    take: MEMBER_QUERY_LIMIT,
  });
  if (members.length === 0) return [];
  const bots = await prisma.user.findMany({
    where: { id: { in: members.map((m) => m.userId) }, isBot: true, isActive: true },
    select: { id: true },
  });
  return bots.map((b) => b.id);
}

async function botIdsFor(agentKeys: readonly AgentKey[]): Promise<string[]> {
  if (agentKeys.length === 0) return [];
  const identities = await identitiesByKey(agentKeys);
  return agentKeys
    .map((key) => identities.get(key)?.botUserId)
    .filter((id): id is string => typeof id === 'string');
}

function uniqueIds(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

// ---------------------------------------------------------------------------
// Area channels
// ---------------------------------------------------------------------------

async function responsiblePeople(area: { key: string; responsibleArea: string; leadUserId: string | null }): Promise<string[]> {
  const responsible = await prisma.responsible.findUnique({
    where: { area: area.responsibleArea || area.key },
    select: { userId: true, backupUserId: true, active: true },
  });
  if (responsible?.active) return uniqueIds([responsible.userId, responsible.backupUserId, area.leadUserId]);
  return uniqueIds([area.leadUserId]);
}

/** Human members an area channel should have (active non-bot users). */
export async function resolveAreaChannelPeople(areaKey: AreaKey): Promise<string[]> {
  const area = await prisma.area.findUnique({
    where: { key: areaKey },
    select: { key: true, responsibleArea: true, leadUserId: true },
  });
  const keys = areaMemberPermissionKeys(areaKey);
  const holders =
    keys.length > 0
      ? await prisma.user.findMany({
          where: {
            isActive: true,
            isBot: false,
            roles: {
              some: { role: { isActive: true, permissions: { some: { permissionKey: { in: keys } } } } },
            },
          },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
          take: MEMBER_QUERY_LIMIT,
        })
      : [];
  const ids = uniqueIds([...holders.map((u) => u.id), ...(area ? await responsiblePeople(area) : [])]);
  if (ids.length === 0) return [];
  const humans = await prisma.user.findMany({
    where: { id: { in: ids }, isActive: true, isBot: false },
    select: { id: true },
  });
  const allowed = new Set(humans.map((u) => u.id));
  return ids.filter((id) => allowed.has(id));
}

export interface AreaChannelResult extends OperationsChannelResult {
  areaKey: AreaKey;
}

/**
 * Idempotent: the chat channel of an area (created the first time, renamed and
 * re-synced afterwards). Throws for unknown areas or when the area row is missing.
 */
export async function ensureAreaChannel(
  areaKey: string,
  options: EnsureChannelOptions = {}
): Promise<AreaChannelResult> {
  if (!isAreaKey(areaKey)) throw new AgentBridgeError('not_found', `Área desconocida: ${areaKey}`);
  const area = await prisma.area.findUnique({
    where: { key: areaKey },
    select: { key: true, label: true, chatChannelId: true },
  });
  if (!area) throw new AgentBridgeError('not_found', `No existe el área ${areaKey}; corre el seed de operaciones`);

  const areaAgent = agentKeyForArea(areaKey);
  const agentKeys = uniqueAgentKeys([ADMIN_AGENT_KEY, areaAgent, ...(options.extraAgentKeys ?? [])]);
  const [createdBy, people, bots, stickyBots] = await Promise.all([
    adminBotUserId(),
    resolveAreaChannelPeople(areaKey),
    botIdsFor(agentKeys),
    currentBotMembers(area.chatChannelId),
  ]);
  const result = await createAreaChannel(areaKey, {
    name: (area.label || AREA_LABELS[areaKey]).slice(0, 100),
    memberUserIds: uniqueIds([...people, ...bots, ...stickyBots]),
    createdBy,
  });
  return { ...result, areaKey };
}

function uniqueAgentKeys(keys: Array<AgentKey | null | undefined>): AgentKey[] {
  return [...new Set(keys.filter((key): key is AgentKey => isAgentKey(key)))];
}

// ---------------------------------------------------------------------------
// Case rooms
// ---------------------------------------------------------------------------

export interface CaseRoomPlan {
  name: string;
  areaKeys: AreaKey[];
  memberUserIds: string[];
  agentKeys: AgentKey[];
}

/** Areas involved in a case, from its active/done steps, work items, requests and incidents. */
export async function involvedAreasOfCase(caseId: string): Promise<AreaKey[]> {
  const [steps, workItems, requests, incidents] = await Promise.all([
    prisma.caseStep.findMany({
      where: { caseId, status: { in: INVOLVED_STEP_STATUSES } },
      select: { areaKey: true },
      take: CASE_ROWS_LIMIT,
    }),
    prisma.workItem.findMany({ where: { caseId }, select: { areaKey: true }, take: CASE_ROWS_LIMIT }),
    prisma.areaRequest.findMany({
      where: { caseId },
      select: { fromAreaKey: true, toAreaKey: true },
      take: CASE_ROWS_LIMIT,
    }),
    prisma.incident.findMany({ where: { caseId }, select: { areaKey: true }, take: CASE_ROWS_LIMIT }),
  ]);
  const keys = new Set<AreaKey>(['ventas']);
  const add = (key: string) => {
    if (isAreaKey(key)) keys.add(key);
  };
  steps.forEach((s) => add(s.areaKey));
  workItems.forEach((w) => add(w.areaKey));
  requests.forEach((r) => {
    add(r.fromAreaKey);
    add(r.toAreaKey);
  });
  incidents.forEach((i) => add(i.areaKey));
  return [...keys].sort();
}

function caseRoomName(opCase: { caseNumber: string; salesOrderNumber: string | null; customerName: string | null }): string {
  const parts = [opCase.caseNumber, opCase.salesOrderNumber, opCase.customerName]
    .map((part) => (part ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const name = parts.join(' · ');
  return name.length > 100 ? `${name.slice(0, 99).trimEnd()}…` : name;
}

/** Name and members of a case room (does not write anything). */
export async function planCaseRoom(caseId: string, options: EnsureChannelOptions = {}): Promise<CaseRoomPlan | null> {
  const opCase = await prisma.operationalCase.findUnique({
    where: { id: caseId },
    select: { id: true, caseNumber: true, salesOrderNumber: true, customerName: true, ownerUserId: true, chatChannelId: true },
  });
  if (!opCase) return null;
  const areaKeys = await involvedAreasOfCase(caseId);
  for (const extra of options.extraAgentKeys ?? []) {
    const covered = agentBotFor(extra)?.coversAreaKey;
    if (covered && !areaKeys.includes(covered)) areaKeys.push(covered);
  }
  const areas = await prisma.area.findMany({
    where: { key: { in: areaKeys } },
    select: { key: true, responsibleArea: true, leadUserId: true },
  });
  const people: string[] = [opCase.ownerUserId];
  for (const area of areas) people.push(...(await responsiblePeople(area)));

  const agentKeys = uniqueAgentKeys([
    ADMIN_AGENT_KEY,
    ...areaKeys.map((key) => agentKeyForArea(key)),
    ...(options.extraAgentKeys ?? []),
  ]);
  const [bots, stickyBots] = await Promise.all([botIdsFor(agentKeys), currentBotMembers(opCase.chatChannelId)]);
  const humans = await prisma.user.findMany({
    where: { id: { in: uniqueIds(people) }, isActive: true, isBot: false },
    select: { id: true },
  });
  const humanIds = new Set(humans.map((h) => h.id));
  return {
    name: caseRoomName(opCase),
    areaKeys: [...areaKeys].sort(),
    memberUserIds: uniqueIds([...uniqueIds(people).filter((id) => humanIds.has(id)), ...bots, ...stickyBots]),
    agentKeys,
  };
}

/** Idempotent: the sales room of a case (created the first time, re-synced afterwards). */
export async function ensureCaseRoom(caseId: string, options: EnsureChannelOptions = {}): Promise<OperationsChannelResult> {
  const plan = await planCaseRoom(caseId, options);
  if (!plan) throw new AgentBridgeError('not_found', `No existe el expediente ${caseId}`);
  return createCaseRoom(caseId, {
    name: plan.name,
    memberUserIds: plan.memberUserIds,
    createdBy: await adminBotUserId(),
  });
}

/** Re-syncs the people of an existing operations channel (area or case) without renaming it. */
export async function resyncOperationsChannel(channelId: string): Promise<void> {
  const channel = await prisma.internalChatChannel.findUnique({ where: { id: channelId }, select: { type: true } });
  if (!channel) throw new AgentBridgeError('not_found', 'Canal no encontrado');
  if (channel.type === 'case') {
    const opCase = await prisma.operationalCase.findUnique({ where: { chatChannelId: channelId }, select: { id: true } });
    const plan = opCase ? await planCaseRoom(opCase.id) : null;
    if (plan) await syncChannelMembers(channelId, plan.memberUserIds);
    return;
  }
  if (channel.type === 'area') {
    const area = await prisma.area.findUnique({ where: { chatChannelId: channelId }, select: { key: true } });
    if (area && isAreaKey(area.key)) await ensureAreaChannel(area.key);
    return;
  }
  throw new AgentBridgeError('channel_not_operational', 'Sólo los canales de área y las salas de venta se sincronizan');
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export interface PostAsAgentOptions {
  replyToId?: string | null;
  priority?: 'normal' | 'urgent';
}

async function isActiveMember(channelId: string, userId: string): Promise<boolean> {
  const member = await prisma.internalChatMember.findUnique({
    where: { channelId_userId: { channelId, userId } },
    select: { leftAt: true },
  });
  return Boolean(member && member.leftAt === null);
}

/** Makes the agent's bot a member of an operations channel by re-ensuring it with the bot included. */
async function joinOperationsChannel(agentKey: AgentKey, channelId: string): Promise<void> {
  const channel = await prisma.internalChatChannel.findUnique({ where: { id: channelId }, select: { type: true } });
  if (!channel) throw new AgentBridgeError('not_found', 'Canal no encontrado');
  if (channel.type === 'case') {
    const opCase = await prisma.operationalCase.findUnique({ where: { chatChannelId: channelId }, select: { id: true } });
    if (!opCase) throw new AgentBridgeError('not_found', 'La sala no está ligada a un expediente');
    await ensureCaseRoom(opCase.id, { extraAgentKeys: [agentKey] });
    return;
  }
  if (channel.type === 'area') {
    const area = await prisma.area.findUnique({ where: { chatChannelId: channelId }, select: { key: true } });
    if (!area) throw new AgentBridgeError('not_found', 'El canal no está ligado a un área');
    await ensureAreaChannel(area.key, { extraAgentKeys: [agentKey] });
    return;
  }
  throw new AgentBridgeError('channel_not_operational', 'Los agentes sólo publican en canales de área y salas de venta');
}

/**
 * Posts `text` as the agent's bot. Joins the bot to the area/case channel when it
 * is not a member yet. For `meta.kind === 'agent_request'` the first post is
 * stored in `AreaRequest.chatMessageId` (only while it is still empty).
 */
export async function postAsAgent(
  agentKey: string,
  channelId: string,
  text: string,
  meta?: ChatMessageMeta | null,
  options: PostAsAgentOptions = {}
): Promise<ChatMessageDTO> {
  if (!isAgentKey(agentKey)) throw new AgentBridgeError('unknown_agent', `Agente desconocido: ${agentKey}`);
  const content = (text ?? '').trim();
  if (!content) throw new AgentBridgeError('empty_message', 'El mensaje del agente está vacío');
  const identity = await requireIdentity(agentKey);
  if (!(await isActiveMember(channelId, identity.botUserId))) {
    await joinOperationsChannel(agentKey, channelId);
  }
  const dto = await sendSystemMessage({ id: identity.botUserId }, channelId, {
    content,
    meta: meta ?? null,
    replyToId: options.replyToId ?? null,
    priority: options.priority ?? 'normal',
  });
  if (meta?.kind === 'agent_request' && typeof meta.requestId === 'string' && meta.requestId) {
    try {
      await prisma.areaRequest.updateMany({
        where: { id: meta.requestId, chatMessageId: null },
        data: { chatMessageId: dto.id },
      });
    } catch (err) {
      warn('request_message_link_failed', {
        requestId: meta.requestId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return dto;
}
