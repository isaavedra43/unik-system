import {
  Prisma,
  type CommAccount,
  type CommContact,
  type CommConversation,
  type CommMessage,
} from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { enqueueJob, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { publishRealtime, REALTIME_CHANNELS } from '@/modules/realtime/realtime-service';
import type { InboundMessage, DeliveryUpdate } from './channel-adapters';
import { getChannelAdapter } from './adapters';
import {
  assertAccountAccess,
  assertInboxAssign,
  assertInboxUse,
  canAccessAccount,
  isInboxAdmin,
  visibleAccountsWhere,
} from './comms-access';
import { handoverBrief, messagePreview, type TranscriptMessage } from './comms-ai';
import {
  toContactDTO,
  upsertContactForInbound,
  type CommContactDTO,
} from './comms-contacts-service';
import { CommsError, assertFound } from './comms-errors';
import { filterReadableObjectIds } from './comms-storage';
import { channelForProvider, detectConsentKeyword, previewText } from './normalize';
import './comms-storage';

export * from './comms-accounts-service';
export * from './comms-contacts-service';

/**
 * Omnichannel inbox service. Single door for outbound messages (consent,
 * media authorization, idempotent provider call) and for inbound persistence
 * (one CommMessage per provider id, thanks to the unique [accountId,
 * externalId] constraint).
 */

export const COMMS_PROCESS_INBOUND_JOB = 'comms.process_inbound';
export const CONVERSATION_STATUSES = ['open', 'pending', 'snoozed', 'resolved'] as const;
export const CONVERSATION_PRIORITIES = ['normal', 'high', 'urgent'] as const;
const INBOUND_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface MessageMediaDTO {
  id: string;
  url: string;
  name: string;
  mimeType: string;
  sizeBytes: string;
}

export interface CommMessageDTO {
  id: string;
  conversationId: string;
  direction: string;
  body: string | null;
  media: MessageMediaDTO[];
  pendingMedia: number;
  status: string;
  error: string | null;
  uncertain: boolean;
  sentByUserId: string | null;
  sentByName: string | null;
  proposalId: string | null;
  campaignId: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

export interface CommConversationDTO {
  id: string;
  accountId: string;
  account: { label: string; provider: string; identifier: string; teamKeys: string[] };
  contact: CommContactDTO;
  status: string;
  assignedToUserId: string | null;
  assignedToName: string | null;
  subject: string | null;
  priority: string;
  tags: string[];
  unreadCount: number;
  lastMessageAt: string;
  lastInboundAt: string | null;
  snoozedUntil: string | null;
  lastMessage: { direction: string; preview: string; createdAt: string } | null;
  createdAt: string;
}

export interface CommNoteDTO {
  id: string;
  conversationId: string;
  authorUserId: string;
  authorName: string | null;
  body: string;
  createdAt: string;
}

type ConversationWithRelations = CommConversation & { account: CommAccount; contact: CommContact };

async function userNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, u.name]));
}

async function mediaFor(messages: CommMessage[]): Promise<Map<string, MessageMediaDTO>> {
  const ids = [...new Set(messages.flatMap((m) => m.mediaObjectIds))];
  if (ids.length === 0) return new Map();
  const objects = await prisma.storageObject.findMany({
    where: { id: { in: ids }, status: 'ready' },
    select: {
      id: true,
      originalName: true,
      declaredMimeType: true,
      detectedMimeType: true,
      sizeBytes: true,
    },
  });
  return new Map(
    objects.map((o) => [
      o.id,
      {
        id: o.id,
        url: `/app/files/api/objects/${o.id}/content`,
        name: o.originalName,
        mimeType: o.detectedMimeType ?? o.declaredMimeType,
        sizeBytes: o.sizeBytes.toString(),
      },
    ])
  );
}

function pendingMediaCount(message: CommMessage): number {
  const meta = (message.providerMeta as Record<string, unknown> | null) ?? {};
  const pending = meta.pendingMedia;
  return Array.isArray(pending) ? pending.length : 0;
}

export async function toMessageDTOs(messages: CommMessage[]): Promise<CommMessageDTO[]> {
  const [names, media] = await Promise.all([
    userNames(messages.map((m) => m.sentByUserId)),
    mediaFor(messages),
  ]);
  return messages.map((m) => {
    const meta = (m.providerMeta as Record<string, unknown> | null) ?? {};
    return {
      id: m.id,
      conversationId: m.conversationId,
      direction: m.direction,
      body: m.body,
      media: m.mediaObjectIds
        .map((id) => media.get(id))
        .filter((x): x is MessageMediaDTO => Boolean(x)),
      pendingMedia: pendingMediaCount(m),
      status: m.status,
      error: m.error,
      uncertain: meta.uncertain === true,
      sentByUserId: m.sentByUserId,
      sentByName: m.sentByUserId ? (names.get(m.sentByUserId) ?? null) : null,
      proposalId: m.proposalId,
      campaignId: m.campaignId,
      createdAt: m.createdAt.toISOString(),
      sentAt: m.sentAt?.toISOString() ?? null,
      deliveredAt: m.deliveredAt?.toISOString() ?? null,
      readAt: m.readAt?.toISOString() ?? null,
    };
  });
}

async function toConversationDTOs(
  rows: ConversationWithRelations[]
): Promise<CommConversationDTO[]> {
  if (rows.length === 0) return [];
  const names = await userNames(rows.map((r) => r.assignedToUserId));
  const lastMessages = await prisma.commMessage.findMany({
    where: { conversationId: { in: rows.map((r) => r.id) } },
    orderBy: { createdAt: 'desc' },
    distinct: ['conversationId'],
    select: {
      conversationId: true,
      direction: true,
      body: true,
      createdAt: true,
      mediaObjectIds: true,
      providerMeta: true,
    },
  });
  const lastByConversation = new Map(lastMessages.map((m) => [m.conversationId, m]));
  return rows.map((r) => {
    const last = lastByConversation.get(r.id);
    return {
      id: r.id,
      accountId: r.accountId,
      account: {
        label: r.account.label,
        provider: r.account.provider,
        identifier: r.account.identifier,
        teamKeys: r.account.teamKeys,
      },
      contact: toContactDTO(r.contact),
      status: r.status,
      assignedToUserId: r.assignedToUserId,
      assignedToName: r.assignedToUserId ? (names.get(r.assignedToUserId) ?? null) : null,
      subject: r.subject,
      priority: r.priority,
      tags: r.tags,
      unreadCount: r.unreadCount,
      lastMessageAt: r.lastMessageAt.toISOString(),
      lastInboundAt: r.lastInboundAt?.toISOString() ?? null,
      snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
      lastMessage: last
        ? {
            direction: last.direction,
            preview: messagePreview(
              last.body,
              last.mediaObjectIds.length > 0 || pendingMediaCount(last as CommMessage) > 0
            ),
            createdAt: last.createdAt.toISOString(),
          }
        : null,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

async function publishToTeams(
  account: Pick<CommAccount, 'teamKeys'>,
  conversation: Pick<CommConversation, 'id' | 'accountId' | 'assignedToUserId'>,
  type: string,
  payload: Record<string, unknown>,
  extraUserIds: Array<string | null | undefined> = []
): Promise<void> {
  const base = { conversationId: conversation.id, accountId: conversation.accountId, ...payload };
  const tasks: Promise<unknown>[] = [];
  for (const key of new Set(account.teamKeys))
    tasks.push(publishRealtime(REALTIME_CHANNELS.inbox(key), type, base));
  for (const userId of new Set([conversation.assignedToUserId, ...extraUserIds])) {
    if (userId) tasks.push(publishRealtime(REALTIME_CHANNELS.user(userId), type, base));
  }
  await Promise.all(tasks.map((t) => t.catch(() => undefined)));
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export const conversationFiltersSchema = z.object({
  accountId: z.string().optional(),
  status: z.enum([...CONVERSATION_STATUSES, 'all']).optional(),
  assigned: z.enum(['me', 'unassigned', 'team', 'all']).optional(),
  assignedToUserId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  search: z.string().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export type ConversationFilters = z.infer<typeof conversationFiltersSchema>;

function encodeCursor(row: Pick<CommConversation, 'lastMessageAt' | 'id'>): string {
  return Buffer.from(`${row.lastMessageAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const at = new Date(iso);
    if (!id || Number.isNaN(at.getTime())) return null;
    return { at, id };
  } catch {
    return null;
  }
}

export async function listConversations(
  user: CurrentUser,
  filters: ConversationFilters
): Promise<{ items: CommConversationDTO[]; nextCursor: string | null }> {
  assertInboxUse(user);
  const limit = filters.limit ?? 30;
  const where: Prisma.CommConversationWhereInput = { account: visibleAccountsWhere(user) };
  if (filters.accountId) where.accountId = filters.accountId;
  if (filters.status && filters.status !== 'all') where.status = filters.status;
  else if (!filters.status) where.status = { not: 'resolved' };
  if (filters.assigned === 'me') where.assignedToUserId = user.id;
  else if (filters.assigned === 'unassigned') where.assignedToUserId = null;
  else if (filters.assignedToUserId) where.assignedToUserId = filters.assignedToUserId;
  if (filters.tags && filters.tags.length > 0) where.tags = { hasSome: filters.tags };
  if (filters.search?.trim()) {
    const q = filters.search.trim();
    where.OR = [
      { contact: { displayName: { contains: q, mode: 'insensitive' } } },
      { contact: { phone: { contains: q.replace(/\s+/g, '') } } },
      { contact: { email: { contains: q, mode: 'insensitive' } } },
      { subject: { contains: q, mode: 'insensitive' } },
      { messages: { some: { body: { contains: q, mode: 'insensitive' } } } },
    ];
  }
  const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
  if (cursor) {
    where.AND = [
      {
        OR: [
          { lastMessageAt: { lt: cursor.at } },
          { lastMessageAt: cursor.at, id: { lt: cursor.id } },
        ],
      },
    ];
  }
  const rows = await prisma.commConversation.findMany({
    where,
    include: { account: true, contact: true },
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;
  return { items: await toConversationDTOs(page), nextCursor };
}

async function loadConversation(user: CurrentUser, id: string): Promise<ConversationWithRelations> {
  assertInboxUse(user);
  const conversation = assertFound(
    await prisma.commConversation.findUnique({
      where: { id },
      include: { account: true, contact: true },
    }),
    'Conversación no encontrada'
  );
  assertAccountAccess(user, conversation.account);
  return conversation;
}

export async function getConversation(user: CurrentUser, id: string): Promise<CommConversationDTO> {
  const conversation = await loadConversation(user, id);
  return (await toConversationDTOs([conversation]))[0];
}

export const conversationPatchSchema = z.object({
  status: z.enum(CONVERSATION_STATUSES).optional(),
  priority: z.enum(CONVERSATION_PRIORITIES).optional(),
  tags: z.array(z.string().min(1).max(40)).max(30).optional(),
  subject: z.string().max(200).nullable().optional(),
  snoozedUntil: z.string().datetime().nullable().optional(),
  assignedToUserId: z.string().nullable().optional(),
});

export type ConversationPatch = z.infer<typeof conversationPatchSchema>;

/**
 * Assignment and status changes. `inbox.assign` is required to assign others
 * or change status; any inbox user may take an unassigned conversation, and
 * the current assignee may resolve/reopen their own.
 */
export async function updateConversation(
  actor: CurrentUser,
  id: string,
  patch: ConversationPatch
): Promise<CommConversationDTO> {
  const conversation = await loadConversation(actor, id);
  const data: Prisma.CommConversationUpdateInput = {};
  const isAssignee = conversation.assignedToUserId === actor.id;
  const canAssign = isInboxAdmin(actor) || actor.permissionKeys.includes('inbox.assign' as never);

  if (patch.assignedToUserId !== undefined) {
    const takingUnassigned = patch.assignedToUserId === actor.id && !conversation.assignedToUserId;
    if (!canAssign && !takingUnassigned) assertInboxAssign(actor);
    if (patch.assignedToUserId) {
      const target = await prisma.user.findUnique({
        where: { id: patch.assignedToUserId },
        select: { id: true, isActive: true },
      });
      if (!target || !target.isActive) throw new CommsError('Usuario destino no válido', 400);
    }
    data.assignedToUserId = patch.assignedToUserId;
  }
  if (patch.status !== undefined) {
    if (!canAssign && !isAssignee) assertInboxAssign(actor);
    data.status = patch.status;
    if (patch.status !== 'snoozed') data.snoozedUntil = null;
  }
  if (patch.snoozedUntil !== undefined) {
    if (!canAssign && !isAssignee) assertInboxAssign(actor);
    data.snoozedUntil = patch.snoozedUntil ? new Date(patch.snoozedUntil) : null;
    if (patch.snoozedUntil) data.status = 'snoozed';
  }
  if (patch.priority !== undefined) data.priority = patch.priority;
  if (patch.tags !== undefined)
    data.tags = [...new Set(patch.tags.map((t) => t.trim()).filter(Boolean))];
  if (patch.subject !== undefined) data.subject = patch.subject;

  const updated = await prisma.commConversation.update({
    where: { id },
    data,
    include: { account: true, contact: true },
  });
  await publishToTeams(updated.account, updated, 'conversation', { fields: Object.keys(patch) }, [
    conversation.assignedToUserId,
  ]);
  return (await toConversationDTOs([updated]))[0];
}

export async function markConversationRead(actor: CurrentUser, id: string): Promise<void> {
  await loadConversation(actor, id);
  await prisma.commConversation.update({ where: { id }, data: { unreadCount: 0 } });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function listMessages(
  user: CurrentUser,
  conversationId: string,
  options: { before?: string; limit?: number } = {}
): Promise<{ items: CommMessageDTO[]; hasMore: boolean }> {
  await loadConversation(user, conversationId);
  const limit = Math.min(200, Math.max(1, options.limit ?? 60));
  const where: Prisma.CommMessageWhereInput = { conversationId };
  if (options.before) {
    const pivot = await prisma.commMessage.findUnique({
      where: { id: options.before },
      select: { createdAt: true },
    });
    if (pivot) where.createdAt = { lt: pivot.createdAt };
  }
  const rows = await prisma.commMessage.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
  });
  const page = rows.slice(0, limit).reverse();
  return { items: await toMessageDTOs(page), hasMore: rows.length > limit };
}

export interface SendOutboundInput {
  accountId: string;
  conversationId: string;
  body: string;
  mediaObjectIds?: string[];
  sentByUserId: string;
  proposalId?: string | null;
  campaignId?: string | null;
  templateKey?: string;
  templateVariables?: Record<string, string>;
  /** When present, media ids are re-validated against this user's file access. */
  actor?: CurrentUser;
}

async function assertConsent(conversation: ConversationWithRelations): Promise<void> {
  const channel = channelForProvider(conversation.account.provider);
  const last = await prisma.consentRecord.findFirst({
    where: { contactId: conversation.contactId, channel },
    orderBy: { recordedAt: 'desc' },
  });
  if (last?.status !== 'opted_out') return;
  const recentInbound =
    conversation.lastInboundAt &&
    Date.now() - conversation.lastInboundAt.getTime() < INBOUND_WINDOW_MS;
  if (recentInbound && conversation.lastInboundAt! > last.recordedAt) return;
  throw new CommsError(
    'El contacto solicitó no recibir mensajes por este canal (baja registrada)',
    409,
    'opted_out'
  );
}

function destinationFor(conversation: ConversationWithRelations): string {
  if (conversation.account.provider === 'telegram') {
    if (!conversation.contact.telegramId)
      throw new CommsError('El contacto no tiene chat de Telegram', 400);
    return conversation.contact.telegramId;
  }
  if (!conversation.contact.phone) throw new CommsError('El contacto no tiene teléfono', 400);
  return conversation.contact.phone;
}

/** The ONLY way an outbound message leaves the inbox. */
export async function sendOutboundMessage(input: SendOutboundInput): Promise<CommMessageDTO> {
  const conversation = assertFound(
    await prisma.commConversation.findUnique({
      where: { id: input.conversationId },
      include: { account: true, contact: true },
    }),
    'Conversación no encontrada'
  );
  if (conversation.accountId !== input.accountId)
    throw new CommsError('La conversación no pertenece a esa cuenta', 400);
  if (input.actor) {
    assertInboxUse(input.actor);
    assertAccountAccess(input.actor, conversation.account);
  }
  if (conversation.account.status !== 'active')
    throw new CommsError('La cuenta está pausada', 409, 'account_paused');
  const body = input.body?.trim() ?? '';
  let mediaObjectIds = [...new Set(input.mediaObjectIds ?? [])];
  if (input.actor && mediaObjectIds.length > 0) {
    const check = await filterReadableObjectIds(input.actor, mediaObjectIds);
    if (check.rejected.length > 0)
      throw new CommsError('Algún adjunto no está disponible o no tienes acceso', 400);
    mediaObjectIds = check.ok;
  }
  if (!body && mediaObjectIds.length === 0 && !input.templateKey)
    throw new CommsError('El mensaje está vacío', 400);
  await assertConsent(conversation);
  const to = destinationFor(conversation);

  const message = await prisma.commMessage.create({
    data: {
      accountId: conversation.accountId,
      conversationId: conversation.id,
      direction: 'outbound',
      body: body || null,
      mediaObjectIds,
      status: 'queued',
      sentByUserId: input.sentByUserId,
      proposalId: input.proposalId ?? null,
      campaignId: input.campaignId ?? null,
      templateKey: input.templateKey ?? null,
    },
  });

  const adapter = getChannelAdapter(conversation.account.provider);
  const result = await adapter.send(conversation.account, {
    to,
    body,
    mediaObjectIds,
    templateKey: input.templateKey,
    templateVariables: input.templateVariables,
    idempotencyKey: message.id,
  });

  const providerMeta: Record<string, unknown> = {
    ...(result.providerMeta ?? {}),
    uncertain: result.uncertain === true,
    cost: result.cost ?? null,
  };
  const now = new Date();
  let updated: CommMessage;
  try {
    updated = await prisma.commMessage.update({
      where: { id: message.id },
      data: {
        status: result.status,
        externalId: result.externalId,
        error: result.error ?? null,
        providerMeta: providerMeta as Prisma.InputJsonValue,
        sentAt: result.status === 'sent' ? now : null,
      },
    });
  } catch (err) {
    // Provider id collision (already stored): keep the row without the id.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      updated = await prisma.commMessage.update({
        where: { id: message.id },
        data: {
          status: result.status,
          error: result.error ?? null,
          providerMeta: providerMeta as Prisma.InputJsonValue,
        },
      });
    } else throw err;
  }
  await prisma.commConversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: now },
  });
  await publishToTeams(
    conversation.account,
    conversation,
    'message',
    {
      messageId: updated.id,
      direction: 'outbound',
      status: updated.status,
    },
    [input.sentByUserId]
  );
  return (await toMessageDTOs([updated]))[0];
}

/**
 * Persists an inbound message exactly once. Returns `created: false` when the
 * provider id was already stored (webhook retries).
 */
export async function recordInboundMessage(
  account: CommAccount,
  inbound: InboundMessage
): Promise<{ created: boolean; message: CommMessage; conversation: CommConversation }> {
  const existing = await prisma.commMessage.findUnique({
    where: { accountId_externalId: { accountId: account.id, externalId: inbound.externalId } },
  });
  if (existing) {
    const conversation = assertFound(
      await prisma.commConversation.findUnique({ where: { id: existing.conversationId } }),
      'Conversación no encontrada'
    );
    return { created: false, message: existing, conversation };
  }

  const contact = await upsertContactForInbound(account.provider, inbound.from, inbound.fromName);
  let conversation = await prisma.commConversation.findFirst({
    where: { accountId: account.id, contactId: contact.id },
    orderBy: { lastMessageAt: 'desc' },
  });
  if (!conversation) {
    conversation = await prisma.commConversation.create({
      data: {
        accountId: account.id,
        contactId: contact.id,
        status: 'open',
        lastMessageAt: inbound.receivedAt,
        lastInboundAt: inbound.receivedAt,
      },
    });
  }

  const providerMeta: Record<string, unknown> = {
    ...(inbound.providerMeta ?? {}),
    fromName: inbound.fromName ?? null,
    pendingMedia: inbound.media.length > 0 ? inbound.media : undefined,
  };
  let message: CommMessage;
  try {
    message = await prisma.commMessage.create({
      data: {
        accountId: account.id,
        conversationId: conversation.id,
        direction: 'inbound',
        externalId: inbound.externalId,
        body: inbound.body,
        status: 'received',
        providerMeta: providerMeta as Prisma.InputJsonValue,
        createdAt: inbound.receivedAt,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const duplicate = assertFound(
        await prisma.commMessage.findUnique({
          where: {
            accountId_externalId: { accountId: account.id, externalId: inbound.externalId },
          },
        }),
        'Mensaje no encontrado'
      );
      return { created: false, message: duplicate, conversation };
    }
    throw err;
  }

  const reopened = conversation.status === 'resolved' || conversation.status === 'snoozed';
  conversation = await prisma.commConversation.update({
    where: { id: conversation.id },
    data: {
      unreadCount: { increment: 1 },
      lastMessageAt: inbound.receivedAt,
      lastInboundAt: inbound.receivedAt,
      ...(reopened ? { status: 'open', snoozedUntil: null } : {}),
    },
  });

  const consent = detectConsentKeyword(inbound.body);
  if (consent) {
    await prisma.consentRecord.create({
      data: {
        contactId: contact.id,
        channel: channelForProvider(account.provider),
        status: consent,
        source: 'keyword',
        note: previewText(inbound.body, 80),
      },
    });
  }

  if (inbound.media.length > 0) {
    await enqueueJob({
      type: COMMS_PROCESS_INBOUND_JOB,
      payload: { messageId: message.id },
      priority: JOB_PRIORITY.interactive,
      dedupeKey: `${COMMS_PROCESS_INBOUND_JOB}:${message.id}`,
      groupKey: `comm_account:${account.id}`,
    }).catch(() => undefined);
  }

  await publishToTeams(account, conversation, 'message', {
    messageId: message.id,
    direction: 'inbound',
    status: 'received',
    reopened,
    consent,
  });
  return { created: true, message, conversation };
}

const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
  undelivered: 4,
};

export async function applyDeliveryUpdate(
  account: CommAccount,
  update: DeliveryUpdate
): Promise<boolean> {
  const message = await prisma.commMessage.findUnique({
    where: { accountId_externalId: { accountId: account.id, externalId: update.externalId } },
  });
  if (!message) return false;
  const current = STATUS_RANK[message.status] ?? 0;
  const next = STATUS_RANK[update.status] ?? 0;
  if (next < current && !(update.status === 'failed' || update.status === 'undelivered'))
    return false;
  const data: Prisma.CommMessageUpdateInput = { status: update.status };
  if (update.status === 'sent' && !message.sentAt) data.sentAt = update.at;
  if (update.status === 'delivered') data.deliveredAt = update.at;
  if (update.status === 'read') data.readAt = update.at;
  if (update.error) data.error = update.error;
  const meta = (message.providerMeta as Record<string, unknown> | null) ?? {};
  if (meta.uncertain) data.providerMeta = { ...meta, uncertain: false } as Prisma.InputJsonValue;
  await prisma.commMessage.update({ where: { id: message.id }, data });
  const conversation = await prisma.commConversation.findUnique({
    where: { id: message.conversationId },
  });
  if (conversation) {
    await publishToTeams(
      account,
      conversation,
      'message_status',
      { messageId: message.id, status: update.status },
      [message.sentByUserId]
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export async function listNotes(user: CurrentUser, conversationId: string): Promise<CommNoteDTO[]> {
  await loadConversation(user, conversationId);
  const notes = await prisma.commNote.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
  });
  const names = await userNames(notes.map((n) => n.authorUserId));
  return notes.map((n) => ({
    id: n.id,
    conversationId: n.conversationId,
    authorUserId: n.authorUserId,
    authorName: names.get(n.authorUserId) ?? null,
    body: n.body,
    createdAt: n.createdAt.toISOString(),
  }));
}

export async function addNote(
  actor: CurrentUser,
  conversationId: string,
  body: string
): Promise<CommNoteDTO> {
  const conversation = await loadConversation(actor, conversationId);
  const text = body.trim();
  if (!text) throw new CommsError('La nota está vacía', 400);
  const note = await prisma.commNote.create({
    data: { conversationId, authorUserId: actor.id, body: text.slice(0, 4000) },
  });
  await publishToTeams(conversation.account, conversation, 'note', { noteId: note.id });
  return {
    id: note.id,
    conversationId,
    authorUserId: actor.id,
    authorName: actor.name,
    body: note.body,
    createdAt: note.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Assisted operator handover
// ---------------------------------------------------------------------------

export async function transcriptFor(
  conversationId: string,
  limit = 30
): Promise<{ messages: TranscriptMessage[]; contactName: string }> {
  const conversation = assertFound(
    await prisma.commConversation.findUnique({
      where: { id: conversationId },
      include: { contact: true },
    }),
    'Conversación no encontrada'
  );
  const rows = await prisma.commMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  const names = await userNames(rows.map((r) => r.sentByUserId));
  const messages: TranscriptMessage[] = rows.reverse().map((r) => ({
    direction: r.direction,
    body: r.body,
    createdAt: r.createdAt,
    sentByName: r.sentByUserId ? (names.get(r.sentByUserId) ?? null) : null,
    hasMedia: r.mediaObjectIds.length > 0 || pendingMediaCount(r) > 0,
  }));
  return { messages, contactName: conversation.contact.displayName };
}

export async function handoverConversation(
  actor: CurrentUser,
  conversationId: string,
  toUserId: string,
  summary?: string
): Promise<{ conversation: CommConversationDTO; note: CommNoteDTO; generatedByAi: boolean }> {
  const conversation = await loadConversation(actor, conversationId);
  const isAssignee = conversation.assignedToUserId === actor.id;
  if (!isAssignee) assertInboxAssign(actor);
  const target = await prisma.user.findUnique({
    where: { id: toUserId },
    select: { id: true, name: true, isActive: true },
  });
  if (!target || !target.isActive) throw new CommsError('Usuario destino no válido', 400);

  let brief = summary?.trim() ?? '';
  let generatedByAi = false;
  if (!brief) {
    const { messages, contactName } = await transcriptFor(conversationId);
    const result = await handoverBrief(messages, contactName, actor.name, actor.id);
    brief = result.text;
    generatedByAi = result.generatedByAi;
  }
  const noteBody = `Relevo de ${actor.name} a ${target.name}${generatedByAi ? ' (resumen generado con IA)' : ''}:\n${brief}`;
  const note = await prisma.commNote.create({
    data: { conversationId, authorUserId: actor.id, body: noteBody.slice(0, 4000) },
  });
  const updated = await prisma.commConversation.update({
    where: { id: conversationId },
    data: {
      assignedToUserId: toUserId,
      status: conversation.status === 'resolved' ? 'open' : conversation.status,
    },
    include: { account: true, contact: true },
  });
  await publishToTeams(
    updated.account,
    updated,
    'handover',
    { fromUserId: actor.id, toUserId, noteId: note.id },
    [actor.id, toUserId]
  );
  return {
    conversation: (await toConversationDTOs([updated]))[0],
    note: {
      id: note.id,
      conversationId,
      authorUserId: actor.id,
      authorName: actor.name,
      body: note.body,
      createdAt: note.createdAt.toISOString(),
    },
    generatedByAi,
  };
}

// ---------------------------------------------------------------------------
// Directory helpers used by the UI
// ---------------------------------------------------------------------------

/** Active users who can work the inbox (assignment / handover targets). */
export async function listInboxUsers(
  actor: CurrentUser
): Promise<Array<{ id: string; name: string; username: string }>> {
  assertInboxUse(actor);
  return prisma.user.findMany({
    where: {
      isActive: true,
      roles: {
        some: {
          role: {
            isActive: true,
            OR: [{ key: 'super_admin' }, { permissions: { some: { permissionKey: 'inbox.use' } } }],
          },
        },
      },
    },
    select: { id: true, name: true, username: true },
    orderBy: { name: 'asc' },
  });
}

export function conversationVisibleTo(
  user: CurrentUser,
  account: Pick<CommAccount, 'teamKeys'>
): boolean {
  return canAccessAccount(user, account);
}
