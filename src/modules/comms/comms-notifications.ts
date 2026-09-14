import type { CommAccount, CommConversation, CommMessage } from '@prisma/client';
import { findUsersWithPermission } from '@/modules/notifications/audience';
import { notifyUser, notifyUsers } from '@/modules/notifications/notification-service';
import { previewText } from './normalize';

/**
 * Inbox (omnichannel) notifications: a customer wrote, or a conversation was
 * assigned to someone. Assigned conversations notify only the assignee; an
 * unassigned one notifies every agent of the account's teams (or every inbox
 * user when the account has no team), mirroring the realtime fan-out.
 */

function conversationUrl(conversationId: string): string {
  return `/app/inbox?conversation=${encodeURIComponent(conversationId)}`;
}

function providerLabel(provider: string): string {
  if (provider.includes('whatsapp')) return 'WhatsApp';
  if (provider.includes('sms')) return 'SMS';
  if (provider.includes('telegram')) return 'Telegram';
  if (provider.includes('email')) return 'Email';
  return 'Bandeja';
}

export async function notifyInboundMessage(input: {
  account: Pick<CommAccount, 'id' | 'provider' | 'teamKeys' | 'label'>;
  conversation: Pick<CommConversation, 'id' | 'assignedToUserId'>;
  message: Pick<CommMessage, 'id' | 'body'>;
  contactName: string | null;
  from: string;
  hasMedia: boolean;
}): Promise<void> {
  const who = input.contactName?.trim() || input.from;
  const title = `${who} · ${providerLabel(input.account.provider)}`;
  const text = previewText(input.message.body ?? '', 140);
  const body = text || (input.hasMedia ? '📎 Envió un archivo' : 'Mensaje nuevo');
  const common = {
    category: 'inbox_message' as const,
    title,
    body,
    url: conversationUrl(input.conversation.id),
    entityType: 'comm_conversation',
    entityId: input.conversation.id,
    metadata: {
      conversationId: input.conversation.id,
      messageId: input.message.id,
      accountId: input.account.id,
    },
    push: { tag: `inbox:${input.conversation.id}`, renotify: true },
  };

  if (input.conversation.assignedToUserId) {
    await notifyUser({
      ...common,
      userId: input.conversation.assignedToUserId,
      dedupeKey: `inbox_msg:${input.message.id}:${input.conversation.assignedToUserId}`,
    });
    return;
  }

  const audience = await findUsersWithPermission('inbox.use', { roleKeys: input.account.teamKeys });
  await notifyUsers(audience, {
    ...common,
    type: 'inbox_message_unassigned',
    dedupeKeyPrefix: `inbox_msg:${input.message.id}`,
  });
}

export async function notifyConversationAssigned(input: {
  conversation: Pick<CommConversation, 'id' | 'assignedToUserId' | 'subject'>;
  contactName: string | null;
  actorUserId: string;
  actorName: string;
}): Promise<void> {
  const target = input.conversation.assignedToUserId;
  if (!target || target === input.actorUserId) return;
  await notifyUser({
    userId: target,
    actorUserId: input.actorUserId,
    category: 'inbox_assigned',
    title: `${input.actorName} te asignó una conversación`,
    body: input.contactName ? `Con ${input.contactName}` : (input.conversation.subject ?? null),
    url: conversationUrl(input.conversation.id),
    entityType: 'comm_conversation',
    entityId: input.conversation.id,
    dedupeKey: `inbox_assign:${input.conversation.id}:${target}:${Date.now().toString(36).slice(0, -1)}`,
    metadata: { conversationId: input.conversation.id, assignedBy: input.actorUserId },
    push: { tag: `inbox:${input.conversation.id}`, renotify: true },
  });
}
