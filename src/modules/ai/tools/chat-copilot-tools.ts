import { z } from 'zod';
import { registerTool } from './registry';
import { previewText } from '@/modules/comms/normalize';
import { markdownLinksToPlain, rewriteArtifactLinksForSharing } from '../artifact-share';

/**
 * Internal-chat tools. `chatChannelId` is injected by the orchestrator when the
 * assistant runs as the chat copilot (CHAT_CHANNEL_ID_TOOLS); from the main
 * assistant the model passes the channel id it got from listChatChannels.
 * All of them require `chat.use` and only read/draft; the only send path stays
 * `sendInternalChatMessage` (external_send → approval).
 */

const CHAT_PERMISSION = 'chat.use';

export function shortChannelLabel(
  c: { type: string; name: string | null; members: { userId: string; name: string }[] },
  actorId: string
): string {
  if (c.type === 'group') return `grupo "${c.name ?? 'sin nombre'}"`;
  const other = c.members.find((m) => m.userId !== actorId);
  return `chat con ${other?.name ?? 'usuario'}`;
}

registerTool({
  name: 'listChatChannels',
  description:
    'Lista los canales y chats directos del chat interno donde el usuario participa (id, nombre, tipo, miembros, no leídos, último mensaje). Úsalo para encontrar el chatChannelId antes de leer o enviar algo por chat interno.',
  category: 'communication',
  requiredPermission: CHAT_PERMISSION,
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({
    search: z.string().max(100).optional().describe('Filtra por nombre del grupo o de la persona'),
    onlyUnread: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { search?: string; onlyUnread?: boolean; limit: number };
    const { listUserChannels } = await import('@/modules/chat/chat-service');
    const channels = await listUserChannels(actor.id);
    const term = args.search?.trim().toLowerCase();
    const rows = channels
      .filter((c) => (args.onlyUnread ? c.unreadCount > 0 : true))
      .filter((c) => !term || shortChannelLabel(c, actor.id).toLowerCase().includes(term) || c.members.some((m) => m.name.toLowerCase().includes(term)))
      .slice(0, args.limit)
      .map((c) => ({
        chatChannelId: c.id,
        label: shortChannelLabel(c, actor.id),
        type: c.type,
        members: c.members.map((m) => ({ userId: m.userId, name: m.name, status: m.status })),
        unreadCount: c.unreadCount,
        lastMessageAt: c.lastMessageAt,
        lastMessagePreview: c.lastMessagePreview,
      }));
    return { count: rows.length, channels: rows };
  },
});

registerTool({
  name: 'getChatChannelMessages',
  description:
    'Lee los mensajes recientes de un canal del chat interno (con remitente, hora, adjuntos, encuestas, eventos). Úsalo para releer más historial del canal actual o para revisar otro canal.',
  category: 'communication',
  requiredPermission: CHAT_PERMISSION,
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({
    chatChannelId: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(40),
    cursor: z.string().optional().describe('id del mensaje más antiguo ya leído, para paginar hacia atrás'),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { chatChannelId: string; limit: number; cursor?: string };
    const { listMessages } = await import('@/modules/chat/chat-service');
    const { messages, hasMore } = await listMessages(args.chatChannelId, actor.id, { limit: args.limit, cursor: args.cursor });
    const ordered = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      chatChannelId: args.chatChannelId,
      hasMore,
      count: ordered.length,
      messages: ordered.map((m) => ({
        id: m.id,
        at: m.createdAt,
        from: m.senderName,
        fromUserId: m.senderId,
        isCurrentUser: m.senderId === actor.id,
        text: m.deletedAt ? '(eliminado)' : m.content,
        priority: m.priority,
        attachments: m.attachments.map((a) => a.fileName),
        poll: m.poll ? { question: m.poll.question, totalVotes: m.poll.totalVotes } : null,
        event: m.event ? { title: m.event.title, startsAt: m.event.startsAt, location: m.event.location } : null,
        isPinned: m.isPinned,
        replyToPreview: m.replyToPreview,
      })),
    };
  },
});

registerTool({
  name: 'searchChatMessages',
  description: 'Busca texto en los mensajes del chat interno (en un canal o en todos los del usuario).',
  category: 'communication',
  requiredPermission: CHAT_PERMISSION,
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({
    query: z.string().min(2).max(200),
    chatChannelId: z.string().optional().describe('Limita la búsqueda a un canal'),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { query: string; chatChannelId?: string; limit: number };
    const { searchMessages } = await import('@/modules/chat/chat-service');
    const rows = await searchMessages(actor.id, args.query, { channelId: args.chatChannelId, limit: args.limit });
    return {
      count: rows.length,
      results: rows.map((m) => ({ id: m.id, chatChannelId: m.channelId, at: m.createdAt, from: m.senderName, text: m.content })),
    };
  },
});

registerTool({
  name: 'summarizeChatChannel',
  description: 'Resume lo conversado en un canal del chat interno en las últimas horas/días (acuerdos, pendientes, quién pidió qué).',
  category: 'communication',
  requiredPermission: CHAT_PERMISSION,
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({
    chatChannelId: z.string().min(1),
    sinceHours: z.number().int().min(1).max(24 * 30).default(24),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { chatChannelId: string; sinceHours: number };
    const { summarizeConversation } = await import('@/modules/chat/chat-ai-service');
    const summary = await summarizeConversation(args.chatChannelId, actor.id, new Date(Date.now() - args.sinceHours * 3_600_000));
    return { chatChannelId: args.chatChannelId, sinceHours: args.sinceHours, summary };
  },
});

registerTool({
  name: 'proposeChatDraft',
  description:
    'Propone al usuario un BORRADOR de mensaje para el canal del chat interno actual. Escribe tú el texto completo. No envía nada: el usuario lo inserta en el redactor y decide.',
  category: 'communication',
  requiredPermission: CHAT_PERMISSION,
  enabledByDefault: true,
  effect: 'draft',
  contextTags: ['all'],
  parameters: z.object({
    chatChannelId: z.string().min(1),
    body: z.string().min(1).max(4000).describe('Texto final listo para enviar al equipo.'),
    rationale: z.string().max(200).optional().describe('Una línea sobre el enfoque elegido.'),
  }),
  summarize: (args) => `Borrador para el chat: "${previewText((args as { body: string }).body, 160)}"`,
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { chatChannelId: string; body: string; rationale?: string };
    const { getChannel } = await import('@/modules/chat/chat-service');
    const channel = await getChannel(args.chatChannelId, actor.id);
    if (!channel) throw new Error('Canal no encontrado o sin acceso');
    const { text } = await rewriteArtifactLinksForSharing(markdownLinksToPlain(args.body), actor.id);
    return {
      draft: text,
      rationale: args.rationale ?? null,
      status: 'draft_ready',
      note: 'El borrador se mostró como tarjeta con el botón "Insertar en el redactor". No lo repitas completo en tu respuesta.',
    };
  },
});

registerTool({
  name: 'pinChatMessage',
  description: 'Fija un mensaje importante en un canal del chat interno (id del mensaje tomado de la transcripción).',
  category: 'communication',
  requiredPermission: CHAT_PERMISSION,
  enabledByDefault: true,
  effect: 'internal_task',
  summarize: (args) => `Fijar mensaje ${(args as { messageId: string }).messageId} en el chat`,
  parameters: z.object({
    chatChannelId: z.string().min(1),
    messageId: z.string().min(1),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { chatChannelId: string; messageId: string };
    const { pinMessage } = await import('@/modules/chat/chat-service');
    await pinMessage(actor, args.chatChannelId, args.messageId);
    return { pinned: true, messageId: args.messageId };
  },
});
