import { chatCompletion } from '@/modules/ai/ai-client';
import { previewText } from './normalize';

/**
 * Assistive AI helpers for the inbox. Everything here produces TEXT for a
 * human; nothing is sent to a customer without an explicit user action.
 * The conversational copilot itself runs through the assistant orchestrator
 * (see inbox-copilot.ts); this file keeps the transcript builder and the
 * standalone draft generator used by the `draftReply` tool.
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

export function messagePreview(body: string | null, hasMedia: boolean): string {
  const text = previewText(body);
  if (text) return text;
  return hasMedia ? '[adjunto]' : '';
}
