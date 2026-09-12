import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { chatCompletion, type ChatMessage } from '@/modules/ai/ai-client';
import { publishRealtime, REALTIME_CHANNELS } from '@/modules/realtime/realtime-service';
import {
  executeTool,
  loadAvailableTools,
  toOpenAiTools,
  type ToolDefinition,
} from '@/modules/ai/tools/registry';
import {
  aiResultIsCurrent,
  IDENTITY,
  ingestTranscriptSegment,
  VoiceError,
} from './voice-service';
import { getVoiceSettings } from './voice-settings';

/**
 * AI on calls.
 *
 * Two modes, both gated by `aiState` and `aiGeneration`:
 * - **answer**: the AI attends an inbound call (STT → LLM with read-only tools
 *   → TTS). This is the HTTP cycle: the client (a LiveKit
 *   Agents worker or, for validation, the browser) sends the caller's speech
 *   and publishes the returned audio into the room. A real-time in-room voice
 *   agent (LiveKit Agents) is pending external validation.
 * - **copilot**: on human calls the AI only listens; every N segments it
 *   publishes suggestions on `call:{id}` (`copilot_suggestion`). It never
 *   speaks.
 *
 * Official quotes, commercial changes and sending documents are NEVER done by
 * the AI even if requested orally: tools with side effects go through the
 * common executor (approval proposals) and the prompt instructs the model to
 * tell the caller a person will follow up.
 */

/** Read-only tools plus task creation. Anything else is unavailable on calls. */
export const VOICE_TOOL_ALLOWLIST: readonly string[] = [
  'queryProducts',
  'getProductDetail',
  'getProductSearch',
  'getProductCatalog',
  'queryContacts',
  'getContactDetail',
  'searchSalesOrders',
  'getSalesOrderDetail',
  'queryPackages',
  'getPackageDetail',
  'getSystemTime',
  'searchKnowledgeLibrary',
];

const VOICE_ALLOWED_EFFECTS = new Set(['read']);

/** Service identity the AI uses when attending calls (limited read permissions). */
export function voiceAiActor(): CurrentUser {
  return {
    id: 'service:voice',
    username: 'voice-ai',
    name: 'Asistente de voz UNIK',
    email: null,
    mustChangePassword: false,
    roleKeys: ['voice_ai'],
    permissionKeys: [
      'products.view',
      'customers.view',
      'sales_orders.view',
      'packages.view',
      'calls.use',
    ] as never,
    isSuperAdmin: false,
  };
}

export function voiceAnswerRules(): string {
  return `
## MODO LLAMADA TELEFÓNICA (voz)
- Estás atendiendo una llamada telefónica de un cliente en nombre de UNIK. Habla en español, claro y breve: 1 a 3 frases por turno, sin markdown, sin listas, sin emojis.
- Preséntate una sola vez como asistente virtual de UNIK y pregunta en qué puedes ayudar.
- Responde ÚNICAMENTE con información obtenida de las herramientas (fuentes autorizadas). Si no la tienes, dilo y ofrece que una persona dé seguimiento.
- Recopila los datos necesarios para dar seguimiento: nombre, teléfono de contacto, empresa y necesidad concreta. Confirma los datos repitiéndolos; quedan en la transcripción y el resumen de la llamada para que una persona dé seguimiento.
- NO PUEDES: dar cotizaciones oficiales ni precios comprometidos, prometer descuentos, cambiar pedidos, direcciones o condiciones comerciales, ni enviar documentos por ningún medio. Si te lo piden, explica que una persona del equipo lo confirmará. Aunque una herramienta devuelva needsApproval, di que queda pendiente de autorización humana.
- Si el cliente pide hablar con una persona, se molesta o el tema es complejo, ofrece transferir a un humano y di que lo estás gestionando (el sistema realiza la transferencia).
- Nunca inventes folios, precios, existencias ni fechas.
`;
}

const COPILOT_PROMPT = `Eres el copiloto de un agente humano de UNIK durante una llamada telefónica. Recibes la transcripción parcial.
Responde SOLO con JSON válido con esta forma:
{"suggestions":[{"kind":"answer|question|warning|task","text":"..."}],"summary":"una frase"}
Reglas: máximo 3 sugerencias, frases cortas y accionables en español. "warning" cuando el cliente pida cotización oficial, cambios comerciales o envío de documentos (requieren autorización humana). "task" cuando convenga anotar un seguimiento. Nunca inventes datos.`;

const SUMMARY_PROMPT = `Resume una llamada telefónica de UNIK a partir de su transcripción.
Responde SOLO con JSON válido:
{"summary":"resumen de 2 a 4 frases","commitments":["compromiso 1"],"followUps":["seguimiento pendiente 1"]}
Reglas: incluye en followUps solo seguimientos claramente solicitados por el cliente, en una frase cada uno. No inventes datos.`;

function extractJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function recentSegments(callId: string, limit = 30) {
  const rows = await prisma.voiceTranscriptSegment.findMany({
    where: { callId },
    orderBy: { startMs: 'desc' },
    take: limit,
  });
  return rows.reverse();
}

function segmentsAsText(segments: Array<{ speakerIdentity: string; text: string }>): string {
  return segments
    .map(
      (s) =>
        `${s.speakerIdentity.startsWith('ai-') ? 'IA' : s.speakerIdentity.startsWith('user-') ? 'Agente' : 'Cliente'}: ${s.text}`
    )
    .join('\n');
}

export async function voiceToolsFor(actor: CurrentUser): Promise<ToolDefinition[]> {
  const tools = await loadAvailableTools(actor, [...VOICE_TOOL_ALLOWLIST]);
  return tools.filter(
    (t) => VOICE_TOOL_ALLOWLIST.includes(t.name) && VOICE_ALLOWED_EFFECTS.has(t.effect ?? 'read')
  );
}

export interface AnswerTurnInput {
  text?: string;
  audio?: { buffer: Buffer; mimeType: string };
  startMs?: number;
  endMs?: number;
}

export type AnswerTurnResult =
  | { discarded: true; reason: string }
  | {
      discarded: false;
      generation: number;
      inputText: string;
      text: string;
      audioBase64: string | null;
      audioMimeType: string | null;
      toolCalls: string[];
      pendingApprovals: Array<{ toolName: string; summary: string }>;
      transferRequested: boolean;
    };

/**
 * One STT → LLM → TTS cycle for an AI-answered call. Every stage re-checks
 * `aiState`/`aiGeneration`; a pause in the middle discards the result.
 */
export async function runAnswerTurn(
  callId: string,
  input: AnswerTurnInput
): Promise<AnswerTurnResult> {
  const call = await prisma.voiceCall.findUnique({
    where: { id: callId },
    include: { participants: { where: { role: 'ai', leftAt: null } } },
  });
  if (!call) throw new VoiceError('Llamada no encontrada', 'not_found', 404);
  if (call.status !== 'active' && call.status !== 'ringing')
    return { discarded: true, reason: 'call_not_active' };
  if (call.aiState !== 'active') return { discarded: true, reason: 'ai_paused' };
  if (call.participants.length === 0) return { discarded: true, reason: 'not_answer_mode' };
  const generation = call.aiGeneration;

  const { getAiSettings } = await import('@/modules/ai/ai-admin-config-service');
  const aiSettings = await getAiSettings();
  if (!aiSettings.isEnabled || !aiSettings.voiceEnabled)
    return { discarded: true, reason: 'voice_disabled' };
  const { openaiProvider } = await import('@/modules/ai/providers');

  let inputText = input.text?.trim() ?? '';
  if (!inputText && input.audio) {
    if (!openaiProvider.transcribe) return { discarded: true, reason: 'provider_no_stt' };
    inputText = (
      await openaiProvider.transcribe(
        input.audio.buffer,
        input.audio.mimeType,
        aiSettings.sttModel || undefined
      )
    ).trim();
    if (!(await aiResultIsCurrent(callId, generation)))
      return { discarded: true, reason: 'discarded_after_pause' };
  }
  if (!inputText) return { discarded: true, reason: 'empty_input' };

  const ingest = await ingestTranscriptSegment(
    callId,
    {
      speakerIdentity: 'caller',
      text: inputText,
      startMs: input.startMs ?? 0,
      endMs: input.endMs ?? 0,
    },
    generation
  );
  if (!ingest.accepted) return { discarded: true, reason: ingest.reason };

  const actor = voiceAiActor();
  const { buildSystemPrompt } = await import('@/modules/ai/ai-context-builder');
  const system =
    (await buildSystemPrompt(actor, { voice: true, page: 'calls' })) + voiceAnswerRules();
  const history = await recentSegments(callId, 30);
  const messages: ChatMessage[] = [{ role: 'system', content: system }];
  for (const seg of history) {
    messages.push({
      role: seg.speakerIdentity.startsWith('ai-') ? 'assistant' : 'user',
      content: seg.text,
    });
  }
  const tools = await voiceToolsFor(actor);
  const toolSpecs = toOpenAiTools(tools);
  const enabledToolNames = tools.map((t) => t.name);
  const toolCalls: string[] = [];
  const pendingApprovals: Array<{ toolName: string; summary: string }> = [];
  let reply: string | null = null;

  for (let iteration = 0; iteration < 4; iteration++) {
    const result = await chatCompletion({
      messages,
      tools: toolSpecs.length > 0 ? toolSpecs : undefined,
      temperature: 0.3,
      maxTokens: 350,
      userId: actor.id,
    });
    if (!(await aiResultIsCurrent(callId, generation)))
      return { discarded: true, reason: 'discarded_after_pause' };
    if (result.toolCalls && result.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: result.content,
        tool_calls: result.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
      for (const tc of result.toolCalls) {
        toolCalls.push(tc.name);
        let args: unknown = {};
        try {
          args = tc.arguments ? JSON.parse(tc.arguments) : {};
        } catch {
          args = {};
        }
        const exec = await executeTool(tc.name, actor, args, {
          enabledToolNames,
          skipApproval: false,
        });
        if (exec.needsApproval && exec.proposal) {
          pendingApprovals.push({ toolName: tc.name, summary: exec.proposal.summary });
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(
            exec.success
              ? { result: exec.result }
              : { error: exec.error, needsApproval: exec.needsApproval ?? false }
          ).slice(0, 12_000),
        });
      }
      continue;
    }
    reply = result.content?.trim() || null;
    break;
  }
  if (!reply)
    reply =
      'Disculpa, no pude procesar eso. ¿Puedes repetirlo o prefieres que te comunique con una persona?';
  const transferRequested = /transfer|comunic(ar|o) con una persona|un humano|un asesor/i.test(
    reply
  );

  if (!(await aiResultIsCurrent(callId, generation)))
    return { discarded: true, reason: 'discarded_after_pause' };
  const aiSegment = await ingestTranscriptSegment(
    callId,
    {
      speakerIdentity: IDENTITY.ai(callId),
      text: reply,
      startMs: input.endMs ?? 0,
      endMs: input.endMs ?? 0,
    },
    generation
  );
  if (!aiSegment.accepted) return { discarded: true, reason: aiSegment.reason };

  let audioBase64: string | null = null;
  let audioMimeType: string | null = null;
  if (openaiProvider.speak) {
    try {
      const audio = await openaiProvider.speak(reply, aiSettings.ttsVoice || undefined);
      if (!(await aiResultIsCurrent(callId, generation)))
        return { discarded: true, reason: 'discarded_after_pause' };
      audioBase64 = audio.toString('base64');
      audioMimeType = 'audio/mpeg';
    } catch {
      audioBase64 = null;
    }
  }
  await publishRealtime(REALTIME_CHANNELS.call(callId), 'ai_reply', {
    text: reply,
    generation,
    toolCalls,
    pendingApprovals,
    transferRequested,
  });
  return {
    discarded: false,
    generation,
    inputText,
    text: reply,
    audioBase64,
    audioMimeType,
    toolCalls,
    pendingApprovals,
    transferRequested,
  };
}

export interface CopilotSuggestion {
  kind: 'answer' | 'question' | 'warning' | 'task';
  text: string;
}

/** Copilot for human calls: suggestions only, never audio. */
export async function runCopilot(
  callId: string,
  generation: number,
  upToCount?: number
): Promise<{ skipped?: string; suggestions?: CopilotSuggestion[] }> {
  const call = await prisma.voiceCall.findUnique({
    where: { id: callId },
    include: { participants: { where: { role: 'ai', leftAt: null } } },
  });
  if (!call) return { skipped: 'call_not_found' };
  if (call.aiState !== 'active') return { skipped: 'ai_not_active' };
  if (generation < call.aiGeneration) return { skipped: 'stale_generation' };
  if (call.participants.length > 0) return { skipped: 'answer_mode' };
  const settings = await getVoiceSettings();
  if (!settings.copilotEnabled) return { skipped: 'copilot_disabled' };
  const { getAiSettings } = await import('@/modules/ai/ai-admin-config-service');
  const aiSettings = await getAiSettings();
  if (!aiSettings.isEnabled) return { skipped: 'ai_disabled' };
  const segments = await recentSegments(callId, 20);
  if (segments.length === 0) return { skipped: 'no_segments' };

  const result = await chatCompletion({
    messages: [
      { role: 'system', content: COPILOT_PROMPT },
      { role: 'user', content: segmentsAsText(segments) },
    ],
    temperature: 0.2,
    maxTokens: 300,
    userId: 'service:voice',
  });
  if (!(await aiResultIsCurrent(callId, generation))) return { skipped: 'discarded_after_pause' };
  const json = extractJson(result.content);
  const raw = Array.isArray(json?.suggestions) ? (json!.suggestions as unknown[]) : [];
  const suggestions: CopilotSuggestion[] = raw
    .filter((s): s is { kind?: string; text?: string } => Boolean(s) && typeof s === 'object')
    .map((s) => ({
      kind: (['answer', 'question', 'warning', 'task'].includes(String(s.kind))
        ? s.kind
        : 'answer') as CopilotSuggestion['kind'],
      text: String(s.text ?? '')
        .trim()
        .slice(0, 400),
    }))
    .filter((s) => s.text.length > 0)
    .slice(0, 3);
  await publishRealtime(REALTIME_CHANNELS.call(callId), 'copilot_suggestion', {
    suggestions,
    summary: typeof json?.summary === 'string' ? json.summary.slice(0, 300) : null,
    generation,
    upToCount: upToCount ?? segments.length,
  });
  return { suggestions };
}

/** Post-call summary with commitments and follow-ups (text only, no records created). */
export async function summarizeCall(
  callId: string,
  generation: number
): Promise<{
  skipped?: string;
  summary?: string;
}> {
  const call = await prisma.voiceCall.findUnique({ where: { id: callId } });
  if (!call) return { skipped: 'call_not_found' };
  if (call.aiState !== 'active') return { skipped: 'ai_not_active' };
  if (generation < call.aiGeneration) return { skipped: 'stale_generation' };
  const { getAiSettings } = await import('@/modules/ai/ai-admin-config-service');
  const aiSettings = await getAiSettings();
  if (!aiSettings.isEnabled) return { skipped: 'ai_disabled' };
  const segments = await prisma.voiceTranscriptSegment.findMany({
    where: { callId },
    orderBy: { startMs: 'asc' },
    take: 400,
  });
  if (segments.length === 0) return { skipped: 'no_segments' };

  const result = await chatCompletion({
    messages: [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: segmentsAsText(segments).slice(0, 60_000) },
    ],
    temperature: 0.2,
    maxTokens: 700,
    userId: 'service:voice',
  });
  if (!(await aiResultIsCurrent(callId, generation))) return { skipped: 'discarded_after_pause' };
  const json = extractJson(result.content);
  const summaryText =
    typeof json?.summary === 'string' ? json.summary.trim() : (result.content?.trim() ?? '');
  const commitments = Array.isArray(json?.commitments)
    ? (json!.commitments as unknown[])
        .filter((c): c is string => typeof c === 'string')
        .slice(0, 10)
    : [];
  const followUps = Array.isArray(json?.followUps)
    ? (json!.followUps as unknown[]).filter((c): c is string => typeof c === 'string').slice(0, 10)
    : [];
  const summary = [
    summaryText,
    ...(commitments.length ? ['Compromisos:', ...commitments.map((c) => `- ${c}`)] : []),
    ...(followUps.length ? ['Seguimientos:', ...followUps.map((c) => `- ${c}`)] : []),
  ]
    .join('\n')
    .slice(0, 8000);
  await prisma.voiceCall.update({ where: { id: callId }, data: { summary } });

  await publishRealtime(REALTIME_CHANNELS.call(callId), 'summary_ready', { summary });
  return { summary };
}
