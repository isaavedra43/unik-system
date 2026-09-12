import { z } from 'zod';
import { registerTool } from './registry';
import { addNote, getConversation, updateConversation } from '@/modules/comms/comms-service';
import { previewText } from '@/modules/comms/normalize';

/**
 * Tools that only make sense inside the inbox copilot. They take the INBOX
 * conversation id (`inboxConversationId`), never the AI thread id: the
 * orchestrator injects it from the copilot context when the model omits it.
 * Results are plain data the copilot UI turns into cards (draft, action chips).
 */

registerTool({
  name: 'suggestNextActions',
  description:
    'Muestra al operador tu lectura de la situación y de 2 a 5 acciones concretas que puedes ejecutar ahora (cada una como un botón). ' +
    'Llámala al final de todo análisis automático y siempre que quieras ofrecer opciones. La "instruction" de cada acción es el texto que el operador te enviará al hacer clic, escríbela como una orden directa para ti.',
  category: 'communication',
  requiredPermission: 'inbox.use',
  enabledByDefault: true,
  effect: 'read',
  contextTags: ['inbox'],
  parameters: z.object({
    situation: z.string().max(300).describe('Lectura en una línea: qué quiere el cliente y en qué punto está.'),
    sentiment: z.enum(['positivo', 'neutral', 'negativo', 'molesto']),
    urgency: z.enum(['baja', 'media', 'alta']),
    actions: z
      .array(
        z.object({
          label: z.string().min(2).max(60).describe('Texto corto del botón, ej. "Redactar respuesta"'),
          instruction: z.string().min(3).max(300).describe('Orden completa que ejecutarás al hacer clic, ej. "Redacta una respuesta confirmando que mañana enviamos la cotización"'),
          kind: z.enum(['reply', 'task', 'lookup', 'status', 'note', 'escalate', 'send', 'other']).default('other'),
        })
      )
      .min(1)
      .max(5),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { actions: unknown[] };
    return { shown: args.actions.length, note: 'Acciones mostradas al operador como botones. No las repitas en texto.' };
  },
});

registerTool({
  name: 'proposeInboxDraft',
  description:
    'Propone al operador un BORRADOR de mensaje para el cliente de la conversación de bandeja actual. Escribe tú el texto completo. No envía nada: el operador lo inserta en el redactor y decide.',
  category: 'communication',
  requiredPermission: 'inbox.use',
  enabledByDefault: true,
  effect: 'draft',
  contextTags: ['inbox'],
  parameters: z.object({
    inboxConversationId: z.string().min(1),
    body: z.string().min(1).max(4000).describe('Texto final listo para enviar, en el idioma del cliente.'),
    rationale: z.string().max(200).optional().describe('Una línea sobre el enfoque elegido (tono, qué se confirma, qué se evita).'),
  }),
  summarize: (args) => `Borrador: "${previewText((args as { body: string }).body, 160)}"`,
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { inboxConversationId: string; body: string; rationale?: string };
    await getConversation(actor, args.inboxConversationId);
    return {
      draft: args.body,
      rationale: args.rationale ?? null,
      status: 'draft_ready',
      note: 'El borrador se mostró como tarjeta con el botón "Insertar en el redactor". No lo repitas completo en tu respuesta.',
    };
  },
});

registerTool({
  name: 'updateInboxConversation',
  description:
    'Cambia estado (open|pending|snoozed|resolved), prioridad (normal|high|urgent), asignación (userId del equipo o null para desasignar), etiquetas o asunto de la conversación de bandeja actual.',
  category: 'communication',
  requiredPermission: 'inbox.use',
  enabledByDefault: true,
  effect: 'internal_task',
  contextTags: ['inbox'],
  parameters: z.object({
    inboxConversationId: z.string().min(1),
    status: z.enum(['open', 'pending', 'snoozed', 'resolved']).optional(),
    priority: z.enum(['normal', 'high', 'urgent']).optional(),
    assignedToUserId: z.string().nullable().optional(),
    addTags: z.array(z.string().min(1).max(40)).max(10).optional(),
    removeTags: z.array(z.string().min(1).max(40)).max(10).optional(),
    subject: z.string().max(200).nullable().optional(),
  }),
  summarize: (args) => {
    const a = args as Record<string, unknown>;
    const parts = Object.entries(a)
      .filter(([k, v]) => k !== 'inboxConversationId' && v !== undefined)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    return `Actualizar conversación: ${parts.join(', ')}`;
  },
  execute: async (actor, rawArgs) => {
    const args = rawArgs as {
      inboxConversationId: string;
      status?: 'open' | 'pending' | 'snoozed' | 'resolved';
      priority?: 'normal' | 'high' | 'urgent';
      assignedToUserId?: string | null;
      addTags?: string[];
      removeTags?: string[];
      subject?: string | null;
    };
    const current = await getConversation(actor, args.inboxConversationId);
    let tags: string[] | undefined;
    if (args.addTags || args.removeTags) {
      const remove = new Set((args.removeTags ?? []).map((t) => t.toLowerCase()));
      tags = [
        ...current.tags.filter((t) => !remove.has(t.toLowerCase())),
        ...(args.addTags ?? []),
      ];
    }
    const updated = await updateConversation(actor, args.inboxConversationId, {
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.assignedToUserId !== undefined ? { assignedToUserId: args.assignedToUserId } : {}),
      ...(tags ? { tags } : {}),
      ...(args.subject !== undefined ? { subject: args.subject } : {}),
    });
    return {
      status: updated.status,
      priority: updated.priority,
      assignedTo: updated.assignedToName,
      tags: updated.tags,
      subject: updated.subject,
    };
  },
});

registerTool({
  name: 'addInboxNote',
  description:
    'Deja una nota interna en la conversación de bandeja actual (solo la ve el equipo, nunca el cliente). Úsala para dejar contexto, acuerdos o un resumen para quien la retome.',
  category: 'communication',
  requiredPermission: 'inbox.use',
  enabledByDefault: true,
  effect: 'internal_task',
  contextTags: ['inbox'],
  parameters: z.object({
    inboxConversationId: z.string().min(1),
    body: z.string().min(1).max(4000),
  }),
  summarize: (args) => `Nota interna: "${previewText((args as { body: string }).body, 160)}"`,
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { inboxConversationId: string; body: string };
    const note = await addNote(actor, args.inboxConversationId, args.body);
    return { noteId: note.id, createdAt: note.createdAt };
  },
});
