import { chatCompletion } from './ai-client';
import { modelForTask } from './model-policy';
import { addMemory, listMemory } from '@/modules/copilot/memory-service';
import type { AiSettings } from './ai-admin-config-service';
import { decide, answerBool } from './decisions/decision-engine';
import { learningSignalDecision } from './decisions/decision-points';

/**
 * Learning from corrections. When the user corrects the assistant or states a
 * business definition ("Recolección significa que falta recoger con el
 * proveedor", "no, Producción es cuando el material está con el fabricante"),
 * a cheap background pass extracts the durable rule and proposes it as a
 * PENDING memory. The user confirms it in "Preferencias y memoria"; from then
 * on it is part of every prompt. Controlled learning: nothing is silently
 * assumed, nothing is lost either.
 */

const CORRECTION_RE =
  /^\s*(no[,.]|no es|no son|eso no|te equivoc|est[aá] mal|incorrecto|en realidad|corrige|correcci[oó]n|ojo[,:]|para nosotros|aqu[ií] (le )?(decimos|llamamos)|nosotros (le )?(decimos|llamamos))/i;
const DEFINITION_RE = /\b(significa|quiere decir|se refiere a|es cuando|le decimos|le llamamos|siempre (es|significa|va)|nunca (es|significa|va))\b/i;

/** Heuristic: does this user message correct or define something? Pure. */
export function detectCorrection(userMessage: string, lastAssistantContent?: string | null): boolean {
  const text = userMessage.trim();
  if (text.length < 8 || text.length > 2000) return false;
  if (text.startsWith('⟦')) return false;
  if (CORRECTION_RE.test(text)) return Boolean(lastAssistantContent) || DEFINITION_RE.test(text);
  return DEFINITION_RE.test(text);
}

export interface Learning {
  content: string;
  kind: 'definition' | 'rule' | 'preference' | 'correction';
}

export function parseLearnings(text: string): Learning[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { learnings?: unknown };
    if (!Array.isArray(parsed.learnings)) return [];
    return parsed.learnings
      .filter((l): l is { content: string; kind?: string } => Boolean(l) && typeof (l as { content?: unknown }).content === 'string')
      .map((l) => ({
        content: l.content.replace(/\s+/g, ' ').trim().slice(0, 300),
        kind: (['definition', 'rule', 'preference', 'correction'] as const).includes(l.kind as Learning['kind']) ? (l.kind as Learning['kind']) : 'correction',
      }))
      .filter((l) => l.content.length >= 12)
      .slice(0, 3);
  } catch {
    return [];
  }
}

const SYSTEM_PROMPT = `Eres el módulo de aprendizaje de un asistente de negocio (ERP UNIK). El usuario acaba de corregir al asistente o de explicar cómo funciona algo en su empresa.
Extrae SOLO reglas durables que sirvan en futuras conversaciones: definiciones de términos internos ("Recolección = falta recoger material con el proveedor"), reglas de negocio ("una orden con nota 'cerrado' debe cerrarse en el sistema"), preferencias estables de formato o de trabajo.
NO extraigas datos de un caso concreto (folios, montos, fechas, nombres de clientes), ni instrucciones de un solo turno.
Responde SOLO JSON: {"learnings": [{"content": "regla en tercera persona, concreta, máx. 200 caracteres", "kind": "definition|rule|preference|correction"}]} (0 a 3 elementos; [] si no hay nada durable).`;

function similar(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const wa = new Set(x.split(' ').filter((w) => w.length > 3));
  const wb = new Set(y.split(' ').filter((w) => w.length > 3));
  if (wa.size === 0 || wb.size === 0) return false;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size) >= 0.7;
}

/**
 * Proposes learnings as pending memories for the user. Never throws; returns
 * how many were proposed. Skips duplicates of existing memories.
 */
export async function captureLearnings(
  settings: AiSettings,
  input: { userId: string; userMessage: string; lastAssistantContent: string | null; answer: string }
): Promise<number> {
  if (!detectCorrection(input.userMessage, input.lastAssistantContent)) return 0;
  // Jev gate: the regex says "looks like a correction"; Jev confirms it is a
  // durable rule before we spend an LLM call extracting it. Unconfident → proceed
  // as before (never lose a learning to a flaky decision call).
  if (settings.jevEnabled) {
    const gate = learningSignalDecision({
      userMessage: input.userMessage,
      lastAssistantContent: input.lastAssistantContent,
    });
    const hasLearning = await decide(gate.state, gate.questions, { userId: input.userId })
      .then((r) => answerBool(r, 'has_learning'))
      .catch(() => null);
    if (hasLearning === false) return 0;
  }
  const model = modelForTask(settings, 'utility');
  const res = await chatCompletion({
    model,
    temperature: 0,
    maxTokens: 400,
    reasoningEffort: 'low',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `RESPUESTA ANTERIOR DEL ASISTENTE (recorte):\n${(input.lastAssistantContent ?? '').slice(-1500)}\n\n` +
          `MENSAJE DEL USUARIO:\n${input.userMessage.slice(0, 2000)}\n\n` +
          `RESPUESTA NUEVA DEL ASISTENTE (recorte):\n${input.answer.slice(0, 1500)}`,
      },
    ],
  });
  const learnings = parseLearnings(res.content ?? '');
  if (learnings.length === 0) return 0;
  const existing = await listMemory(input.userId, { includeArchived: true }).catch(() => []);
  let proposed = 0;
  for (const l of learnings) {
    if (existing.some((m) => similar(m.content, l.content))) continue;
    await addMemory(input.userId, l.content, { source: 'correction', tags: [l.kind, 'auto'] });
    proposed += 1;
  }
  return proposed;
}
