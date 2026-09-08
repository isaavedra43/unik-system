import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export interface ConversationRow {
  id: string;
  title: string;
  isStarred: boolean;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRow {
  id: string;
  role: string;
  content: string | null;
  toolCalls: unknown;
  toolCallId: string | null;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  createdAt: string;
  toolCallRecords?: Array<{
    id: string;
    toolName: string;
    args: unknown;
    result: unknown;
    durationMs: number;
    success: boolean;
    errorCode: string | null;
  }>;
}

function formatConv(c: Prisma.AiConversationGetPayload<object>): ConversationRow {
  return {
    id: c.id,
    title: c.title,
    isStarred: c.isStarred,
    messageCount: 0, // filled by caller if needed
    lastMessageAt: null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function formatMsg(m: Prisma.AiMessageGetPayload<object>): MessageRow {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls,
    toolCallId: m.toolCallId,
    tokensIn: m.tokensIn,
    tokensOut: m.tokensOut,
    latencyMs: m.latencyMs,
    createdAt: m.createdAt.toISOString(),
  };
}

function formatMsgWithToolCalls(
  m: Prisma.AiMessageGetPayload<{ include: { toolCallRecords: true } }>
): MessageRow {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls,
    toolCallId: m.toolCallId,
    tokensIn: m.tokensIn,
    tokensOut: m.tokensOut,
    latencyMs: m.latencyMs,
    createdAt: m.createdAt.toISOString(),
    toolCallRecords: m.toolCallRecords.map((tc) => ({
      id: tc.id,
      toolName: tc.toolName,
      args: tc.args,
      result: tc.result,
      durationMs: tc.durationMs,
      success: tc.success,
      errorCode: tc.errorCode,
    })),
  };
}

export async function createConversation(
  userId: string,
  context?: Record<string, unknown>
): Promise<{ id: string }> {
  const conv = await prisma.aiConversation.create({
    data: {
      userId,
      context: context ? (context as Prisma.InputJsonValue) : Prisma.JsonNull,
    },
  });
  return { id: conv.id };
}

export async function getConversation(
  id: string,
  userId: string
): Promise<{ conversation: ConversationRow | null; messages: MessageRow[] }> {
  const conv = await prisma.aiConversation.findFirst({ where: { id, userId } });
  if (!conv) return { conversation: null, messages: [] };
  const messages = await prisma.aiMessage.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: 'asc' },
    take: 100,
    include: { toolCallRecords: true },
  });
  const convRow = formatConv(conv);
  convRow.messageCount = messages.length;
  convRow.lastMessageAt = messages.length > 0 ? messages[messages.length - 1].createdAt.toISOString() : null;
  return { conversation: convRow, messages: messages.map((m) => formatMsgWithToolCalls(m)) };
}

export async function listConversations(
  userId: string,
  opts?: { starredOnly?: boolean; search?: string }
): Promise<ConversationRow[]> {
  const where: Prisma.AiConversationWhereInput = { userId };
  if (opts?.starredOnly) where.isStarred = true;
  if (opts?.search) where.title = { contains: opts.search, mode: 'insensitive' };
  const convs = await prisma.aiConversation.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });
  return convs.map(formatConv);
}

export async function deleteConversation(id: string, userId: string): Promise<void> {
  await prisma.aiConversation.deleteMany({ where: { id, userId } });
}

export async function renameConversation(id: string, userId: string, title: string): Promise<void> {
  await prisma.aiConversation.updateMany({ where: { id, userId }, data: { title } });
}

export async function toggleStar(id: string, userId: string): Promise<void> {
  const conv = await prisma.aiConversation.findFirst({ where: { id, userId } });
  if (!conv) return;
  await prisma.aiConversation.update({ where: { id }, data: { isStarred: !conv.isStarred } });
}

export async function addMessage(
  conversationId: string,
  role: string,
  content: string | null,
  toolCalls: unknown,
  tokensIn: number,
  tokensOut: number,
  latencyMs: number,
  toolCallId?: string
): Promise<{ id: string }> {
  const msg = await prisma.aiMessage.create({
    data: {
      conversationId,
      role,
      content,
      toolCalls: toolCalls ? (toolCalls as Prisma.InputJsonValue) : Prisma.JsonNull,
      toolCallId: toolCallId ?? null,
      tokensIn,
      tokensOut,
      latencyMs,
    },
  });
  // Update conversation updatedAt
  await prisma.aiConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  return { id: msg.id };
}

export async function getMessages(
  conversationId: string,
  userId: string,
  limit: number
): Promise<MessageRow[]> {
  // Verify ownership
  const conv = await prisma.aiConversation.findFirst({ where: { id: conversationId, userId } });
  if (!conv) return [];
  const messages = await prisma.aiMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return messages.reverse().map(formatMsg);
}

export async function autoTitleConversation(
  conversationId: string,
  firstMessage: string
): Promise<void> {
  const conv = await prisma.aiConversation.findUnique({ where: { id: conversationId } });
  if (conv && conv.title === 'Nueva conversación') {
    const title = firstMessage.slice(0, 60).trim() + (firstMessage.length > 60 ? '…' : '');
    await prisma.aiConversation.update({ where: { id: conversationId }, data: { title } });
  }
}
