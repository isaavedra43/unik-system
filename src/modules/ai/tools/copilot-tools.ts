import { z } from 'zod';
import { registerTool } from './registry';
import { searchKnowledge } from '@/modules/copilot/knowledge-service';
import { addMemory, deleteMemory, listMemory } from '@/modules/copilot/memory-service';
import { markdownLinksToPlain, rewriteArtifactLinksForSharing } from '../artifact-share';
import { previewText } from '@/modules/comms/normalize';
import { shortChannelLabel } from './chat-copilot-tools';

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
  effect: 'internal_task',
  parameters: z.object({ memoryId: z.string().min(1) }),
  execute: async (actor, rawArgs) => ({
    deleted: await deleteMemory(actor.id, (rawArgs as { memoryId: string }).memoryId),
  }),
});

registerTool({
  name: 'sendInternalChatMessage',
  description:
    'Envía un mensaje por el chat interno a un canal/grupo (channelId, de listChatChannels) o a una persona por su nombre (recipient) o id (recipientUserId, de findUsers); si no hay DM con esa persona se crea al enviar. El envío requiere la aprobación del usuario.',
  category: 'communication',
  enabledByDefault: true,
  requiredPermission: 'chat.use',
  effect: 'external_send',
  contextTags: ['all'],
  summarize: (args) => {
    const a = args as {
      channelId?: string;
      recipient?: string;
      content: string;
      priority?: string;
      _targetLabel?: string;
    };
    const dest = a._targetLabel ?? a.recipient ?? a.channelId ?? 'destinatario';
    return `Enviar por chat interno a ${dest}${a.priority === 'urgent' ? ' (URGENTE)' : ''}: "${previewText(a.content, 160)}"`;
  },
  parameters: z.object({
    channelId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Canal/grupo/DM del chat interno (de listChatChannels; el usuario debe ser miembro)'
      ),
    recipient: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'Nombre del grupo o de la persona. Si coincide con varios destinos se rechaza con los candidatos.'
      ),
    recipientUserId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'id de usuario de UNIK (de findUsers) para mandarle un DM; crea el chat si no existe'
      ),
    content: z.string().min(1).max(4000),
    priority: z.enum(['normal', 'urgent']).default('normal'),
  }),
  // Who exactly? Resolved before the approval card so the user approves a concrete
  // destination; an ambiguous name is refused with the candidates so the model can ask.
  prepareArgs: async (actor, rawArgs) => {
    const a = rawArgs as {
      channelId?: string;
      recipient?: string;
      recipientUserId?: string;
      content: string;
      priority?: 'normal' | 'urgent';
    };
    const { getChannel, listUserChannels } = await import('@/modules/chat/chat-service');

    if (a.channelId) {
      const channel = await getChannel(a.channelId, actor.id);
      if (!channel) {
        return {
          error:
            'Canal no encontrado o no eres miembro. Usa listChatChannels para ver los disponibles.',
        };
      }
      return { args: { ...a, _targetLabel: shortChannelLabel(channel, actor.id) } };
    }

    if (a.recipientUserId) {
      if (a.recipientUserId === actor.id) {
        return { error: 'El chat interno no permite un canal del usuario consigo mismo.' };
      }
      const { prisma } = await import('@/lib/prisma');
      const user = await prisma.user.findUnique({
        where: { id: a.recipientUserId, isActive: true },
        select: { name: true },
      });
      if (!user) return { error: 'Usuario no encontrado o inactivo. Localízalo con findUsers.' };
      return { args: { ...a, _targetLabel: `chat con ${user.name}` } };
    }

    const term = a.recipient?.trim();
    if (!term) {
      return {
        error:
          'Falta el destinatario: channelId (de listChatChannels), recipientUserId (de findUsers) o recipient con el nombre del grupo o la persona.',
      };
    }
    const { findUsersByQuery } = await import('@/modules/notifications/audience');
    const [channels, users] = await Promise.all([
      listUserChannels(actor.id),
      findUsersByQuery(term, { excludeUserId: actor.id, limit: 10 }),
    ]);
    const lower = term.toLowerCase();
    const channelMatches = channels.filter((c) =>
      (c.type === 'group' ? (c.name ?? '') : shortChannelLabel(c, actor.id))
        .toLowerCase()
        .includes(lower)
    );
    // A DM channel already covering a matched user is the same destination.
    const dmUserIds = new Set(
      channelMatches
        .filter((c) => c.type === 'dm')
        .map((c) => c.members.find((m) => m.userId !== actor.id)?.userId)
        .filter((id): id is string => Boolean(id))
    );
    const userMatches = users.filter((u) => !dmUserIds.has(u.id));

    if (channelMatches.length + userMatches.length === 0) {
      return {
        error: `No encontré "${term}" entre tus canales ni los usuarios activos. Revisa con listChatChannels o findUsers, o pregunta al usuario.`,
      };
    }
    if (channelMatches.length + userMatches.length > 1) {
      const options = [
        ...channelMatches.map((c) => shortChannelLabel(c, actor.id)),
        ...userMatches.map((u) => `${u.name} (@${u.username})`),
      ];
      return {
        error: `"${term}" es ambiguo: ${options.join('; ')}. Pregunta al usuario a cuál se refiere.`,
      };
    }
    if (channelMatches.length === 1) {
      return {
        args: {
          ...a,
          channelId: channelMatches[0].id,
          _targetLabel: shortChannelLabel(channelMatches[0], actor.id),
        },
      };
    }
    return {
      args: {
        ...a,
        recipientUserId: userMatches[0].id,
        _targetLabel: `chat con ${userMatches[0].name}`,
      },
    };
  },
  execute: async (actor, rawArgs) => {
    const args = rawArgs as {
      channelId?: string;
      recipientUserId?: string;
      content: string;
      priority?: 'normal' | 'urgent';
    };
    const { sendMessage, createDmChannel, getChannel } =
      await import('@/modules/chat/chat-service');
    let channelId = args.channelId;
    if (!channelId && args.recipientUserId) {
      channelId = (await createDmChannel(actor, args.recipientUserId)).id;
    }
    if (!channelId) throw new Error('Falta el destinatario (channelId o recipientUserId).');
    // Reports linked in the message become public share links (the recipient is not the owner).
    const { text } = await rewriteArtifactLinksForSharing(
      markdownLinksToPlain(args.content),
      actor.id
    );
    const message = await sendMessage(actor, {
      channelId,
      content: text,
      priority: args.priority ?? 'normal',
    });
    const channel = await getChannel(channelId, actor.id).catch(() => null);
    return {
      messageId: message.id,
      channelId,
      sentTo: channel ? shortChannelLabel(channel, actor.id) : channelId,
      sentAt: message.createdAt,
    };
  },
});
