import { z } from 'zod';
import { registerTool } from './registry';
import {
  getConversation,
  listConversations,
  listMessages,
  listPendingDuplicates,
  sendOutboundMessage,
  transcriptFor,
} from '@/modules/comms/comms-service';
import { suggestReply } from '@/modules/comms/comms-ai';
import { createCommitment, listCommitments } from '@/modules/comms/commitments-service';
import { previewText } from '@/modules/comms/normalize';

/**
 * Assistant tools for the omnichannel inbox and commitments. Reads run directly; `sendInboxMessage` is an
 * `external_send` so the common executor ALWAYS creates a proposal that the
 * user approves in the chat before anything leaves UNIK.
 */

registerTool({
  name: 'listInboxConversations',
  description:
    'Lista conversaciones de la bandeja omnicanal (WhatsApp, SMS, Telegram) visibles para el usuario. ' +
    'Filtra por estado (open/pending/snoozed/resolved), asignación (me/unassigned/all) y búsqueda de texto en mensajes o contacto.',
  category: 'communication',
  requiredPermission: 'inbox.use',
  enabledByDefault: true,
  effect: 'read',
  contextTags: ['all'],
  parameters: z.object({
    status: z.enum(['open', 'pending', 'snoozed', 'resolved', 'all']).optional(),
    assigned: z.enum(['me', 'unassigned', 'all']).optional(),
    search: z.string().max(200).optional(),
    accountId: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  execute: async (actor, args) => {
    const a = args as {
      status?: 'open' | 'pending' | 'snoozed' | 'resolved' | 'all';
      assigned?: 'me' | 'unassigned' | 'all';
      search?: string;
      accountId?: string;
      limit: number;
    };
    const result = await listConversations(actor, {
      status: a.status,
      assigned: a.assigned,
      search: a.search,
      accountId: a.accountId,
      limit: a.limit,
    });
    return {
      conversations: result.items.map((c) => ({
        id: c.id,
        contact: c.contact.displayName,
        channel: c.account.provider,
        account: c.account.label,
        status: c.status,
        assignedTo: c.assignedToName,
        unread: c.unreadCount,
        lastMessageAt: c.lastMessageAt,
        lastMessage: c.lastMessage?.preview ?? null,
      })),
      nextCursor: result.nextCursor,
    };
  },
});

registerTool({
  name: 'getConversationMessages',
  description:
    'Devuelve los últimos mensajes de una conversación de la bandeja (texto, dirección, estado de entrega).',
  category: 'communication',
  requiredPermission: 'inbox.use',
  enabledByDefault: true,
  effect: 'read',
  contextTags: ['all'],
  parameters: z.object({
    conversationId: z.string(),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  execute: async (actor, args) => {
    const a = args as { conversationId: string; limit: number };
    const [conversation, messages] = await Promise.all([
      getConversation(actor, a.conversationId),
      listMessages(actor, a.conversationId, { limit: a.limit }),
    ]);
    return {
      contact: conversation.contact.displayName,
      channel: conversation.account.provider,
      status: conversation.status,
      messages: messages.items.map((m) => ({
        id: m.id,
        direction: m.direction,
        body: m.body,
        media: m.media.length,
        status: m.status,
        at: m.createdAt,
        by: m.sentByName,
      })),
    };
  },
});

registerTool({
  name: 'draftReply',
  description:
    'Redacta un BORRADOR de respuesta para una conversación de la bandeja. No envía nada: el usuario lo revisa e inserta en el redactor.',
  category: 'communication',
  requiredPermission: 'inbox.use',
  enabledByDefault: true,
  effect: 'draft',
  contextTags: ['all'],
  parameters: z.object({
    conversationId: z.string(),
    instructions: z
      .string()
      .max(500)
      .optional()
      .describe('Indicaciones sobre el tono o contenido.'),
  }),
  execute: async (actor, args) => {
    const a = args as { conversationId: string; instructions?: string };
    await getConversation(actor, a.conversationId);
    const { messages, contactName } = await transcriptFor(a.conversationId);
    const draft = await suggestReply(messages, contactName, {
      instructions: a.instructions,
      userId: actor.id,
    });
    return {
      draft,
      note: 'Borrador. Requiere que el usuario lo envíe manualmente o apruebe sendInboxMessage.',
    };
  },
});

registerTool({
  name: 'sendInboxMessage',
  description:
    'Envía un mensaje a un contacto por la conversación indicada (WhatsApp/SMS/Telegram). Requiere aprobación explícita del usuario.',
  category: 'communication',
  requiredPermission: 'inbox.use',
  enabledByDefault: true,
  effect: 'external_send',
  contextTags: ['all'],
  parameters: z.object({
    conversationId: z.string(),
    body: z.string().min(1).max(4000),
  }),
  summarize: (args) => {
    const a = args as { conversationId: string; body: string };
    return `Enviar por la bandeja (conversación ${a.conversationId}): "${previewText(a.body, 200)}"`;
  },
  execute: async (actor, args) => {
    const a = args as { conversationId: string; body: string };
    const conversation = await getConversation(actor, a.conversationId);
    const message = await sendOutboundMessage({
      accountId: conversation.accountId,
      conversationId: conversation.id,
      body: a.body,
      sentByUserId: actor.id,
      actor,
    });
    return {
      messageId: message.id,
      status: message.status,
      to: conversation.contact.displayName,
      uncertain: message.uncertain,
      error: message.error,
    };
  },
});

registerTool({
  name: 'listCommitments',
  description:
    'Lista compromisos del usuario (pendientes y vencidos por defecto), opcionalmente por contacto.',
  category: 'communication',
  requiredPermission: 'inbox.use',
  enabledByDefault: true,
  effect: 'read',
  contextTags: ['all'],
  parameters: z.object({
    status: z.enum(['pending', 'overdue', 'done', 'cancelled', 'all']).optional(),
    contactId: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  execute: async (actor, args) => {
    const a = args as { status?: string; contactId?: string; limit: number };
    const items = await listCommitments(actor, {
      status: a.status,
      contactId: a.contactId,
      limit: a.limit,
    });
    return { commitments: items };
  },
});

registerTool({
  name: 'createCommitment',
  description:
    'Registra un compromiso con un contacto (qué se prometió y para cuándo) para darle seguimiento.',
  category: 'communication',
  requiredPermission: 'inbox.use',
  enabledByDefault: true,
  effect: 'internal_task',
  contextTags: ['all'],
  parameters: z.object({
    description: z.string().min(3).max(500),
    dueAt: z.string().datetime().optional(),
    contactId: z.string().optional(),
    conversationId: z.string().optional(),
  }),
  summarize: (args) => {
    const a = args as { description: string; dueAt?: string };
    return `Registrar compromiso: "${previewText(a.description, 120)}"${a.dueAt ? ` para ${a.dueAt}` : ''}`;
  },
  execute: async (actor, args) => {
    const a = args as {
      description: string;
      dueAt?: string;
      contactId?: string;
      conversationId?: string;
    };
    const commitment = await createCommitment(actor, {
      description: a.description,
      dueAt: a.dueAt ?? null,
      contactId: a.contactId ?? null,
      sourceType: a.conversationId ? 'comm_message' : 'ai_conversation',
      sourceId: a.conversationId ?? null,
    });
    return { commitmentId: commitment.id, dueAt: commitment.dueAt, status: commitment.status };
  },
});

registerTool({
  name: 'findDuplicateContacts',
  description:
    'Lista contactos marcados como posibles duplicados pendientes de revisión humana (con el contacto sospechoso y las razones).',
  category: 'communication',
  requiredPermission: 'inbox.use',
  enabledByDefault: true,
  effect: 'read',
  contextTags: ['all'],
  parameters: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
  execute: async (actor, args) => {
    const a = args as { limit: number };
    const items = await listPendingDuplicates(actor);
    return {
      pending: items.slice(0, a.limit).map((d) => ({
        contactId: d.contact.id,
        contact: d.contact.displayName,
        suspectedId: d.suspected?.id ?? null,
        suspected: d.suspected?.displayName ?? null,
        reasons: d.reasons,
      })),
      total: items.length,
      note: 'La fusión requiere confirmación humana en /app/admin/comms.',
    };
  },
});
