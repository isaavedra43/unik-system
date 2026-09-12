import { chatCompletion } from '@/modules/ai/ai-client';
import { previewText } from './normalize';

/**
 * Assistive AI for the inbox: summaries, reply suggestions, translations and
 * the handover brief. Everything here produces TEXT for a human; nothing is
 * sent to a customer without an explicit user action.
 */

export interface TranscriptMessage {
  direction: string;
  body: string | null;
  createdAt: Date;
  sentByName?: string | null;
  hasMedia?: boolean;
}

const MAX_TRANSCRIPT_MESSAGES = 30;

export function buildTranscript(messages: TranscriptMessage[], contactName: string): string {
  return messages
    .slice(-MAX_TRANSCRIPT_MESSAGES)
    .map((m) => {
      const who =
        m.direction === 'inbound'
          ? contactName
          : m.sentByName
            ? `Agente (${m.sentByName})`
            : 'Agente';
      const when = m.createdAt.toISOString().slice(0, 16).replace('T', ' ');
      const body = m.body?.trim() || (m.hasMedia ? '[adjunto]' : '[sin texto]');
      return `[${when}] ${who}: ${body}`;
    })
    .join('\n');
}

/** Deterministic fallback used when the AI provider is unavailable. */
export function plainTextDigest(
  messages: TranscriptMessage[],
  contactName: string,
  count = 5
): string {
  const last = messages.slice(-count);
  if (last.length === 0) return 'Sin mensajes previos.';
  return `Últimos ${last.length} mensajes:\n${buildTranscript(last, contactName)}`;
}

async function complete(
  system: string,
  user: string,
  options: { userId?: string; maxTokens?: number } = {}
): Promise<string> {
  const result = await chatCompletion({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    maxTokens: options.maxTokens ?? 600,
    userId: options.userId,
  });
  const content = result.content?.trim();
  if (!content) throw new Error('La IA no devolvió contenido');
  return content;
}

export async function summarizeConversation(
  messages: TranscriptMessage[],
  contactName: string,
  userId?: string
): Promise<string> {
  const transcript = buildTranscript(messages, contactName);
  return complete(
    'Eres un asistente de atención al cliente de UNIK. Resume conversaciones de WhatsApp/SMS/Telegram en español, en máximo 6 viñetas: motivo del contacto, lo que se acordó, pendientes y tono del cliente. No inventes datos.',
    `Contacto: ${contactName}\n\nConversación:\n${transcript}\n\nResumen:`,
    { userId }
  );
}

export async function suggestReply(
  messages: TranscriptMessage[],
  contactName: string,
  options: { instructions?: string; userId?: string } = {}
): Promise<string> {
  const transcript = buildTranscript(messages, contactName);
  return complete(
    'Eres un agente de atención de UNIK. Redacta UNA respuesta breve, cordial y profesional en español para enviar por mensajería al cliente. Responde solo con el texto del mensaje, sin comillas ni explicaciones. No prometas plazos ni precios que no aparezcan en la conversación.',
    `Contacto: ${contactName}\n\nConversación:\n${transcript}\n\n${options.instructions ? `Indicaciones del agente: ${options.instructions}\n\n` : ''}Respuesta sugerida:`,
    { userId: options.userId, maxTokens: 400 }
  );
}

export async function translateText(
  text: string,
  targetLanguage: string,
  userId?: string
): Promise<string> {
  return complete(
    `Traduce el texto al idioma "${targetLanguage}". Devuelve solo la traducción, sin comentarios.`,
    text,
    { userId, maxTokens: 800 }
  );
}

/**
 * Brief for the operator taking over a conversation. Falls back to a plain
 * digest of the last messages if the AI provider fails.
 */
export async function handoverBrief(
  messages: TranscriptMessage[],
  contactName: string,
  fromName: string,
  userId?: string
): Promise<{ text: string; generatedByAi: boolean }> {
  try {
    const transcript = buildTranscript(messages, contactName);
    const text = await complete(
      'Eres un asistente que prepara el relevo entre operadores de atención. Escribe en español un resumen operativo (máximo 8 líneas) para quien recibe la conversación: quién es el cliente, qué necesita, qué ya se le respondió, compromisos pendientes y siguiente paso recomendado. Sin inventar datos.',
      `Operador saliente: ${fromName}\nContacto: ${contactName}\n\nConversación:\n${transcript}\n\nResumen de relevo:`,
      { userId, maxTokens: 500 }
    );
    return { text, generatedByAi: true };
  } catch {
    return { text: plainTextDigest(messages, contactName, 5), generatedByAi: false };
  }
}

export function messagePreview(body: string | null, hasMedia: boolean): string {
  const text = previewText(body);
  if (text) return text;
  return hasMedia ? '[adjunto]' : '';
}
