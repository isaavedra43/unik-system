import { z } from 'zod';
import { registerTool } from './registry';
import { searchKnowledge } from '@/modules/copilot/knowledge-service';
import { addMemory, deleteMemory, listMemory } from '@/modules/copilot/memory-service';

/**
 * Copilot tools: approved knowledge library, personal memory (controlled
 * learning) and internal communication proposals.
 */

registerTool({
  name: 'searchKnowledgeLibrary',
  description:
    'Busca en la biblioteca APROBADA de UNIK (fichas, políticas, manuales). Devuelve fragmentos con fuente, versión y si son internos o publicables. Úsala antes de afirmar datos de productos, políticas o procesos. Si la respuesta va a un cliente, pide visibility="publishable".',
  category: 'knowledge',
  enabledByDefault: true,
  requiredPermission: 'assistant.use',
  effect: 'read',
  parameters: z.object({
    query: z.string().min(2).max(300).describe('Términos de búsqueda'),
    visibility: z
      .enum(['internal', 'publishable'])
      .optional()
      .describe('publishable = solo contenido que puede salir a clientes'),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      query: string;
      visibility?: 'internal' | 'publishable';
      limit?: number;
    };
    const hits = await searchKnowledge(args.query, {
      visibility: args.visibility,
      limit: args.limit,
    });
    return {
      total: hits.length,
      hits,
      note:
        hits.length === 0
          ? 'Sin coincidencias en la biblioteca aprobada. No inventes: dilo y ofrece consultar a un responsable.'
          : 'Cita la fuente (título y versión) al usar estos fragmentos. Los marcados "internal" NO se comparten con clientes.',
    };
  },
});

registerTool({
  name: 'rememberForUser',
  description:
    'Propone guardar en la memoria personal del usuario un hecho o preferencia estable (o una corrección que te hizo). Queda PENDIENTE hasta que el usuario lo confirme en su panel de memoria.',
  category: 'knowledge',
  enabledByDefault: true,
  requiredPermission: 'assistant.use',
  effect: 'internal_task',
  parameters: z.object({
    content: z
      .string()
      .min(3)
      .max(500)
      .describe('Texto breve en tercera persona, ej. "Prefiere reportes en Excel"'),
    kind: z.enum(['preference', 'fact', 'correction']).default('fact'),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { content: string; kind: 'preference' | 'fact' | 'correction' };
    const memory = await addMemory(actor.id, args.content, {
      source: args.kind === 'correction' ? 'correction' : 'assistant',
      tags: [args.kind],
    });
    return {
      memoryId: memory.id,
      status: memory.status,
      note: 'Pendiente de confirmación del usuario.',
    };
  },
});

registerTool({
  name: 'listUserMemory',
  description: 'Lista la memoria personal activa y pendiente del usuario actual.',
  category: 'knowledge',
  enabledByDefault: true,
  requiredPermission: 'assistant.use',
  effect: 'read',
  parameters: z.object({}),
  execute: async (actor) => ({ memories: await listMemory(actor.id) }),
});

registerTool({
  name: 'forgetMemory',
  description:
    'Elimina un recuerdo de la memoria personal del usuario (a petición explícita del usuario).',
  category: 'knowledge',
  enabledByDefault: true,
  requiredPermission: 'assistant.use',
  effect: 'internal_task',
  parameters: z.object({ memoryId: z.string().min(1) }),
  execute: async (actor, rawArgs) => ({
    deleted: await deleteMemory(actor.id, (rawArgs as { memoryId: string }).memoryId),
  }),
});

registerTool({
  name: 'sendInternalChatMessage',
  description:
    'Propone enviar un mensaje por el chat interno a un canal del usuario (p. ej. avisar a un responsable). El envío requiere la aprobación del usuario.',
  category: 'communication',
  enabledByDefault: true,
  requiredPermission: 'chat.use',
  effect: 'external_send',
  summarize: (args) => {
    const a = args as { channelId: string; content: string };
    return `Enviar por chat interno al canal ${a.channelId}: "${a.content.slice(0, 200)}"`;
  },
  parameters: z.object({
    channelId: z
      .string()
      .min(1)
      .describe('Canal o DM del chat interno (el usuario debe ser miembro)'),
    content: z.string().min(1).max(4000),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { channelId: string; content: string };
    const { sendMessage } = await import('@/modules/chat/chat-service');
    const message = await sendMessage(actor, { channelId: args.channelId, content: args.content });
    return { messageId: message.id, channelId: message.channelId, sentAt: message.createdAt };
  },
});
