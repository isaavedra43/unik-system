/**
 * Chat AI service.
 *
 * Provides AI-powered features for the chat:
 * - Conversation summarization
 * - Message translation
 * - Smart reply suggestions
 *
 * Reuses the existing AI provider infrastructure (getActiveProvider).
 * If no provider is configured or available, functions throw a clear error
 * that the UI can display gracefully.
 */

import { prisma } from '@/lib/prisma';
import { getActiveProvider } from '@/modules/ai/providers';
import type { ChatMessage } from '@/modules/ai/providers/types';

export class ChatAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatAiError';
  }
}

async function callAi(messages: ChatMessage[]): Promise<string> {
  let provider;
  try {
    provider = await getActiveProvider();
  } catch {
    throw new ChatAiError('No hay un proveedor de IA configurado');
  }

  const result = await provider.chatCompletion({
    messages,
    temperature: 0.3,
    maxTokens: 1000,
  });

  return result.content ?? '';
}

// =====================================================
// Summarize conversation
// =====================================================

export async function summarizeConversation(
  channelId: string,
  userId: string,
  since?: Date
): Promise<string> {
  // Verify membership
  const membership = await prisma.internalChatMember.findFirst({
    where: { channelId, userId, leftAt: null },
  });
  if (!membership) throw new ChatAiError('No tienes acceso a este canal');

  const sinceDate = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const messages = await prisma.internalChatMessage.findMany({
    where: { channelId, createdAt: { gte: sinceDate }, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    take: 100,
    include: { sender: { select: { name: true } } },
  });

  if (messages.length === 0) {
    return 'No hay mensajes en el período seleccionado para resumir.';
  }

  const conversationText = messages
    .map((m) => `${m.sender.name}: ${m.content ?? '[archivo]'}`)
    .join('\n');

  const aiMessages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Eres un asistente que resume conversaciones de chat interno empresarial. ' +
        'Resume los puntos clave, decisiones y pendientes en español, de forma concisa (máx 200 palabras). ' +
        'Usa viñetas. No inventes información.',
    },
    {
      role: 'user',
      content: `Resume la siguiente conversación:\n\n${conversationText}`,
    },
  ];

  return callAi(aiMessages);
}

// =====================================================
// Translate message
// =====================================================

export async function translateMessage(
  messageId: string,
  userId: string,
  targetLang = 'es'
): Promise<string> {
  const message = await prisma.internalChatMessage.findUnique({
    where: { id: messageId },
    include: { sender: { select: { name: true } } },
  });
  if (!message) throw new ChatAiError('Mensaje no encontrado');

  // Verify membership
  const membership = await prisma.internalChatMember.findFirst({
    where: { channelId: message.channelId, userId, leftAt: null },
  });
  if (!membership) throw new ChatAiError('No tienes acceso a este canal');

  if (!message.content) {
    throw new ChatAiError('Este mensaje no tiene texto para traducir');
  }

  const langName =
    targetLang === 'es'
      ? 'español'
      : targetLang === 'en'
        ? 'inglés'
        : targetLang === 'fr'
          ? 'francés'
          : targetLang;

  const aiMessages: ChatMessage[] = [
    {
      role: 'system',
      content:
        `Eres un traductor profesional. Traduce el siguiente texto al ${langName}. ` +
        'Devuelve SOLO la traducción, sin explicaciones ni notas.',
    },
    {
      role: 'user',
      content: message.content,
    },
  ];

  return callAi(aiMessages);
}

// =====================================================
// Smart replies
// =====================================================

export async function suggestSmartReplies(channelId: string, userId: string): Promise<string[]> {
  // Verify membership
  const membership = await prisma.internalChatMember.findFirst({
    where: { channelId, userId, leftAt: null },
  });
  if (!membership) throw new ChatAiError('No tienes acceso a este canal');

  // Get last few messages for context
  const messages = await prisma.internalChatMessage.findMany({
    where: { channelId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: { sender: { select: { name: true } } },
  });

  if (messages.length === 0) {
    return [];
  }

  const conversationText = messages
    .reverse()
    .map((m) => `${m.sender.name}: ${m.content ?? '[archivo]'}`)
    .join('\n');

  const aiMessages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Eres un asistente que sugiere respuestas breves para un chat interno empresarial. ' +
        'Genera exactamente 3 respuestas cortas (máx 15 palabras cada una), una por línea, sin numeración ni explicación. ' +
        'Las respuestas deben ser profesionales y en español.',
    },
    {
      role: 'user',
      content: `Conversación reciente:\n${conversationText}\n\nSugiere 3 respuestas:`,
    },
  ];

  const result = await callAi(aiMessages);
  const replies = result
    .split('\n')
    .map((r) => r.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter((r) => r.length > 0)
    .slice(0, 3);

  return replies;
}
