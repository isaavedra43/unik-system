import { z } from 'zod';
import { registerTool } from './registry';
import {
  createOutboundCall,
  getTranscript,
  listCalls,
  pauseAi,
} from '@/modules/voice/voice-service';

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

