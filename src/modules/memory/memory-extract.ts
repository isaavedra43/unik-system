import { chatCompletion } from '@/modules/ai/ai-client';
import { modelForTask } from '@/modules/ai/model-policy';
import type { AiSettings } from '@/modules/ai/ai-admin-config-service';
import { decide, answerBool } from '@/modules/ai/decisions/decision-engine';
import { memoryGateDecision } from '@/modules/ai/decisions/decision-points';
import { recordEpisode, proposeFact, recordPlaybook } from './memory-service';

/**
 * Post-turn memory write. Jev decides whether the turn is worth remembering
 * (cheap gate); when it is, the utility model distills the episode, any
 * durable facts and the tool pattern that worked. Facts arrive `pending` —
 * the user confirms them; nothing is silently asserted.
 */

const EXTRACT_PROMPT = `Eres el módulo de memoria de un asistente de ERP (UNIK). Destila el turno en JSON:
{"episode": {"summary": "qué pidió el usuario y qué se encontró/hizo, ≤240 chars, sin cifras volátiles si no importan", "entities": ["clientes/folios/productos/personas mencionadas"], "importance": 1-10},
 "facts": [{"entity": "tema", "attribute": "propiedad", "value": "hecho durable"}],
 "playbook": {"trigger": "intención del usuario en palabras", "toolName": "tool que resolvió", "argsTemplate": {...args sin folios/fechas concretas...}, "note": "por qué funcionó"}}

Reglas:
- episode: solo si hubo consulta de datos, decisión, corrección o trabajo real. importance alto para correcciones y hallazgos.
- facts: SOLO hechos durables del negocio/usuario (definiciones, preferencias, relaciones). NUNCA cifras ni datos de un caso concreto.
- playbook: solo si el patrón tool+args resolvió algo que podría repetirse (ej. qué filtros usar para cierta pregunta). Omite campos específicos del caso.
- [] / null donde no aplique. Responde SOLO JSON.`;

interface Extracted {
  episode?: { summary?: string; entities?: string[]; importance?: number } | null;
  facts?: Array<{ entity?: string; attribute?: string; value?: string }> | null;
  playbook?: { trigger?: string; toolName?: string; argsTemplate?: Record<string, unknown>; note?: string } | null;
}

export function parseExtraction(text: string): Extracted {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  try {
    return JSON.parse(text.slice(start, end + 1)) as Extracted;
  } catch {
    return {};
  }
}

export interface TurnMemoryInput {
  userId: string;
  conversationId: string;
  userMessage: string;
  answer: string;
  toolsUsed: string[];
  /** URLs realmente consultadas este turno (web/fetch/browser) — trazabilidad. */
  sourceUrls?: string[];
  /** Archivos/artefactos realmente generados este turno. */
  artifacts?: string[];
}

export async function extractAndStoreMemory(settings: AiSettings, input: TurnMemoryInput): Promise<void> {
  // Cheap gate: skip trivial turns without spending an extraction call.
  if (settings.jevEnabled) {
    const gate = memoryGateDecision({
      userMessage: input.userMessage,
      answer: input.answer,
      toolsUsed: input.toolsUsed,
    });
    const memorable = await decide(gate.state, gate.questions, { userId: input.userId })
      .then((r) => answerBool(r, 'memorable'))
      .catch(() => null);
    if (memorable === false) return;
  }

  const res = await chatCompletion({
    model: modelForTask(settings, 'utility'),
    temperature: 0,
    maxTokens: 600,
    reasoningEffort: 'low',
    messages: [
      { role: 'system', content: EXTRACT_PROMPT },
      {
        role: 'user',
        content:
          `MENSAJE DEL USUARIO:\n${input.userMessage.slice(0, 1500)}\n\n` +
          `TOOLS USADAS: ${input.toolsUsed.join(', ') || 'ninguna'}\n` +
          (input.sourceUrls?.length ? `FUENTES CONSULTADAS: ${input.sourceUrls.slice(0, 15).join(', ')}\n` : '') +
          (input.artifacts?.length ? `ARCHIVOS GENERADOS: ${input.artifacts.slice(0, 10).join(', ')}\n` : '') +
          `\nRESPUESTA DEL ASISTENTE (recorte):\n${input.answer.slice(0, 2500)}`,
      },
    ],
  });
  const parsed = parseExtraction(res.content ?? '');

  const tasks: Promise<unknown>[] = [];
  if (parsed.episode?.summary && parsed.episode.summary.trim().length >= 8) {
    tasks.push(
      recordEpisode(input.userId, {
        conversationId: input.conversationId,
        summary: parsed.episode.summary,
        // Source domains + artifact names join entities so "lo que vimos de
        // amazon.com" or "ese reporte PDF" recall the episode by keyword.
        entities: [
          ...(parsed.episode.entities ?? []),
          ...(input.sourceUrls ?? []).slice(0, 8).map((u) => {
            try {
              return new URL(u).hostname.replace(/^www\./, '');
            } catch {
              return u.slice(0, 60);
            }
          }),
          ...(input.artifacts ?? []).slice(0, 5),
        ],
        toolNames: input.toolsUsed,
        importance: parsed.episode.importance,
      })
    );
  }
  for (const f of (parsed.facts ?? []).slice(0, 3)) {
    if (f?.entity && f.attribute && f.value) {
      tasks.push(
        proposeFact(input.userId, {
          entity: f.entity,
          attribute: f.attribute,
          value: f.value,
          source: 'observation',
          sourceRef: input.conversationId,
        }).then(() => undefined)
      );
    }
  }
  if (parsed.playbook?.trigger && parsed.playbook.toolName && input.toolsUsed.includes(parsed.playbook.toolName)) {
    tasks.push(
      recordPlaybook(input.userId, {
        trigger: parsed.playbook.trigger,
        toolName: parsed.playbook.toolName,
        argsTemplate: parsed.playbook.argsTemplate ?? {},
        note: parsed.playbook.note,
      })
    );
  }
  await Promise.allSettled(tasks);
}
