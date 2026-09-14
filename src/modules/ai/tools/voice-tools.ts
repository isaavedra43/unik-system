import { z } from 'zod';
import { registerTool } from './registry';
import { absoluteUrl } from '@/lib/app-url';
import { resolveContact } from '@/modules/comms/contact-resolver';
import { prisma } from '@/lib/prisma';
import {
  createOutboundCall,
  getTranscript,
  listCalls,
  pauseAi, getCall } from '@/modules/voice/voice-service';

/**
 * Voice tools for the assistant.
 *
 * - listCalls / getCallTranscript: read (scoped by calls.use / calls.supervise).
 * - startOutboundCall: external effect → goes through the approval executor.
 * - pauseCallAi: internal task (no approval, audited).
 *
 * Official quotes, commercial changes and document sending are never
 * available here.
 */

registerTool({
  name: 'listCalls',
  description:
    'Lista llamadas de voz (internas, entrantes y salientes) visibles para el usuario: estado, tipo, ' +
    'duración, IA activa/pausada y grabación. Úsalo para "mis llamadas", "llamadas de hoy", "llamadas activas".',
  category: 'communication',
  requiredPermission: 'calls.use',
  enabledByDefault: true,
  effect: 'read',
  contextTags: ['all'],
  parameters: z.object({
    status: z
      .array(z.enum(['ringing', 'active', 'ended', 'failed', 'missed']))
      .optional()
      .describe('Filtrar por estado.'),
    type: z
      .array(z.enum(['internal', 'inbound', 'outbound']))
      .optional()
      .describe('Filtrar por tipo.'),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  execute: async (actor, args) => {
    const a = args as {
      status?: Array<'ringing' | 'active' | 'ended' | 'failed' | 'missed'>;
      type?: Array<'internal' | 'inbound' | 'outbound'>;
      limit: number;
    };
    const calls = await listCalls(actor, { status: a.status, type: a.type, limit: a.limit });
    return {
      count: calls.length,
      calls: calls.map((c) => ({
        id: c.id,
        type: c.type,
        status: c.status,
        externalNumber: c.externalNumber,
        aiState: c.aiState,
        aiMode: c.aiMode,
        recordingState: c.recordingState,
        hasRecording: Boolean(c.recordingObjectId),
        durationSec: c.durationSec,
        startedAt: c.startedAt,
        endedAt: c.endedAt,
        participants: c.participants.map((p) => ({ role: p.role, name: p.userName ?? p.identity })),
        summary: c.summary,
      })),
    };
  },
});

registerTool({
  name: 'getCallTranscript',
  description:
    'Devuelve la transcripción y el resumen de una llamada (si el usuario puede verla: participante o supervisor de su equipo).',
  category: 'communication',
  requiredPermission: 'calls.use',
  enabledByDefault: true,
  effect: 'read',
  contextTags: ['all'],
  parameters: z.object({ callId: z.string().min(1) }),
  execute: async (actor, args) => {
    const { callId } = args as { callId: string };
    const { call, segments } = await getTranscript(actor, callId);
    return {
      callId: call.id,
      status: call.status,
      summary: call.summary,
      aiState: call.aiState,
      segments: segments.map((s) => ({
        speaker: s.speakerIdentity,
        text: s.text,
        startMs: s.startMs,
      })),
    };
  },
});

registerTool({
  name: 'startOutboundCall',
  description:
    'Inicia una llamada telefónica saliente a un número E.164 desde la cuenta indicada. ' +
    'Requiere aprobación del usuario antes de marcar.',
  category: 'communication',
  requiredPermission: 'calls.use',
  enabledByDefault: false,
  effect: 'external_send',
  approvalPolicy: 'require_approval',
  contextTags: ['all'],
  parameters: z.object({
    toNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Formato E.164'),
    accountId: z.string().optional(),
    contactId: z.string().optional(),
  }),
  summarize: (args) => {
    const a = args as { toNumber: string };
    return `Llamar al ${a.toNumber}`;
  },
  execute: async (actor, args) => {
    const a = args as { toNumber: string; accountId?: string; contactId?: string };
    const { call } = await createOutboundCall(actor, {
      toNumber: a.toNumber,
      accountId: a.accountId ?? null,
      contactId: a.contactId ?? null,
    });
    return { callId: call.id, status: call.status, roomName: call.roomName, mock: call.mock };
  },
});

registerTool({
  name: 'pauseCallAi',
  description:
    'Pausa la IA en una llamada: deja de escuchar, transcribir, analizar y hablar. Los resultados en curso se descartan.',
  category: 'communication',
  requiredPermission: 'calls.use',
  enabledByDefault: true,
  effect: 'internal_task',
  contextTags: ['all'],
  parameters: z.object({ callId: z.string().min(1) }),
  summarize: (args) => `Pausar IA en la llamada ${(args as { callId: string }).callId}`,
  execute: async (actor, args) => {
    const { callId } = args as { callId: string };
    const call = await pauseAi(actor, callId);
    return { callId: call.id, aiState: call.aiState, aiGeneration: call.aiGeneration };
  },
});



registerTool({
  name: 'callContact',
  description:
    'Llama por teléfono a un contacto (nombre o número). mode="me": marcas y el usuario contesta desde UNIK (devuelve joinUrl). mode="ai": la asistente de voz hace la llamada sola y dice/pregunta lo indicado en "brief" (ej. "avísale que su pedido está listo para recoger y pregúntale a qué hora pasa"); al terminar hay transcripción y resumen. Requiere aprobación.',
  category: 'communication',
  requiredPermission: 'calls.use',
  enabledByDefault: true,
  effect: 'external_send',
  approvalPolicy: 'require_approval',
  contextTags: ['all'],
  parameters: z.object({
    contact: z.string().min(1).describe('Nombre, teléfono (+52…) o id del contacto'),
    mode: z.enum(['me', 'ai']).default('me'),
    brief: z.string().max(1500).optional().describe('Solo mode="ai": qué debe decir/preguntar la asistente'),
    accountId: z.string().optional().describe('Cuenta telefónica desde la que marcar (opcional)'),
  }),
  summarize: (args) => {
    const a = args as { contact: string; mode: 'me' | 'ai'; brief?: string };
    return a.mode === 'ai'
      ? `Que la asistente de voz llame a ${a.contact} y: ${(a.brief ?? '').slice(0, 160)}`
      : `Llamar a ${a.contact} (tú contestas desde UNIK)`;
  },
  execute: async (actor, args) => {
    const a = args as { contact: string; mode: 'me' | 'ai'; brief?: string; accountId?: string };
    if (a.mode === 'ai' && !a.brief?.trim()) return { error: 'Para que la IA llame necesitas indicar qué debe decir (brief).' };
    const contact = await resolveContact(a.contact);
    if (!contact.phone) return { error: `${contact.displayName} no tiene teléfono registrado` };
    const toNumber = contact.phone.replace(/[\s().-]/g, '');
    if (!/^\+[1-9]\d{6,14}$/.test(toNumber)) return { error: `El teléfono de ${contact.displayName} (${contact.phone}) no está en formato internacional (+52…). Corrígelo en el contacto.` };
    // Voice-capable account: the one the user named, or the first Twilio account of their teams.
    let accountId = a.accountId ?? null;
    if (!accountId) {
      const account = await prisma.commAccount.findFirst({
        where: {
          status: 'active',
          provider: { startsWith: 'twilio' },
          ...(actor.isSuperAdmin ? {} : { OR: [{ teamKeys: { isEmpty: true } }, { teamKeys: { hasSome: actor.roleKeys } }] }),
        },
        orderBy: [{ provider: 'asc' }, { label: 'asc' }],
        select: { id: true },
      });
      accountId = account?.id ?? null;
    }
    const { call, mock } = await createOutboundCall(actor, {
      toNumber,
      accountId,
      contactId: contact.commContactId ?? null,
      aiAnswers: a.mode === 'ai',
      aiBrief: a.mode === 'ai' ? a.brief ?? null : null,
    }).then((r) => ({ call: r.call, mock: r.call.mock }));
    // Give the SIP bridge a moment: a call that died right away must not be reported as "sonando".
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const fresh = await getCall(actor, call.id).catch(() => call);
    if (fresh.status === 'failed' || fresh.status === 'missed') {
      throw new Error(`La llamada a ${contact.displayName} no pudo iniciarse (estado: ${fresh.status}). Revisa la cuenta de voz de Twilio y el trunk saliente de LiveKit; el administrador puede probar desde Llamadas → Nueva llamada.`);
    }
    return {
      callId: call.id,
      to: contact.displayName,
      phone: toNumber,
      status: fresh.status,
      mode: a.mode,
      mock,
      accountId,
      joinUrl: absoluteUrl(`/app/calls?call=${call.id}`),
      dock: 'auto',
      note: mock
        ? 'ATENCIÓN: la telefonía está en MODO SIMULACIÓN (LiveKit/Twilio sin configurar): la llamada NO sonará en el teléfono real. Dilo claramente al usuario y que el administrador configure LIVEKIT_URL, LIVEKIT_API_KEY/SECRET y LIVEKIT_SIP_TRUNK_ID.'
        : a.mode === 'ai'
          ? 'La asistente de voz ya está marcando; la llamada aparece en la barra flotante de UNIK (el usuario puede escuchar, intervenir, pausar la IA o colgar). Al terminar usa getCallTranscript para el resumen. No pidas abrir enlaces.'
          : 'La llamada ya está sonando y se abrió automáticamente en la barra flotante de UNIK (abajo a la derecha): el usuario contesta ahí con su micrófono, aunque cambie de módulo. No le pidas abrir enlaces; solo confirma que está marcando.',
    };
  },
});

registerTool({
  name: 'startInternalCall',
  description:
    'Prepara una llamada interna (voz o video) con otro usuario de UNIK: abre el chat directo con esa persona y devuelve el enlace que inicia la llamada desde el navegador. La IA no participa en llamadas internas.',
  category: 'communication',
  requiredPermission: 'chat.use',
  enabledByDefault: true,
  effect: 'internal_task',
  contextTags: ['all'],
  parameters: z.object({
    user: z.string().min(1).describe('Nombre o usuario de la persona'),
    type: z.enum(['audio', 'video']).default('audio'),
  }),
  execute: async (actor, args) => {
    const a = args as { user: string; type: 'audio' | 'video' };
    const target = await prisma.user.findFirst({
      where: { isActive: true, id: { not: actor.id }, OR: [{ name: { contains: a.user, mode: 'insensitive' } }, { username: { equals: a.user, mode: 'insensitive' } }] },
      select: { id: true, name: true },
    });
    if (!target) return { error: `No encontré al usuario "${a.user}"` };
    const { createDmChannel } = await import('@/modules/chat/chat-service');
    const channel = await createDmChannel(actor, target.id);
    return {
      user: target.name,
      chatChannelId: channel.id,
      openUrl: absoluteUrl(`/app/chat?channel=${channel.id}&call=${a.type}`),
      action: 'internal_call',
      note: 'UNIK abre el chat con esa persona y la llamada empieza sola en el navegador del usuario. Solo confirma en una línea que estás llamando.',
    };
  },
});
