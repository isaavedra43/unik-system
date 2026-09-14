import { chatCompletion } from './ai-client';
import { modelForTask } from './model-policy';
import type { AiSettings } from './ai-admin-config-service';

/**
 * Internal review of a complex answer BEFORE it reaches the user ("think, then
 * check"). A second pass with the complex model reads the request, the tools
 * that ran and the draft answer, and returns concrete problems: parts of the
 * request that were not delivered, numbers that do not add up, tables cut
 * short, work postponed ("un momento"), categories invented, artifacts linked
 * by hand. When there are problems the orchestrator sends them back to the
 * model as a critique and lets it rewrite once. Never blocks on failure.
 */

export interface AnswerReviewInput {
  userMessage: string;
  answer: string;
  toolsUsed: Array<{ name: string; success: boolean }>;
  hadAttachments: boolean;
  documentGenerated: boolean;
}

export interface AnswerReviewVerdict {
  approved: boolean;
  issues: string[];
  model: string;
}

export function parseReviewVerdict(text: string): { approved: boolean; issues: string[] } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { approved?: unknown; issues?: unknown };
    const issues = Array.isArray(parsed.issues) ? parsed.issues.filter((i): i is string => typeof i === 'string' && i.trim().length > 0).slice(0, 6) : [];
    const approved = parsed.approved === true || (parsed.approved === undefined && issues.length === 0);
    return { approved: approved && issues.length === 0, issues };
  } catch {
    return null;
  }
}

const REVIEW_SYSTEM_PROMPT = `Eres el revisor interno de un asistente de negocio (ERP UNIK). Recibes la petición del usuario, las herramientas que se ejecutaron y el borrador de respuesta. Tu trabajo es detectar SOLO problemas reales y concretos:
1. Partes de la petición que no se entregaron (pidió tabla + comparación + agrupación y falta alguna).
2. Trabajo pospuesto: "un momento", "voy a…", promesas en lugar de resultados.
3. Cifras inconsistentes: conteos por grupo que no suman el total, "20 órdenes" con 12 filas, totales que no cuadran.
4. Tablas incompletas ("…", "etc.", "y N más") cuando debían traer todas las filas.
5. Categorías o datos inventados que la fuente no respalda, sin decirlo.
6. Errores de forma graves: imágenes markdown "![...]()", enlaces escritos a mano a archivos generados, respuesta desordenada sin estructura cuando era un análisis.
No pidas cambios de estilo menores ni más detalle del pedido. Si el borrador cumple, apruébalo.
Responde SOLO JSON: {"approved": true|false, "issues": ["problema concreto y qué debe corregir", ...]} (máx. 6 issues, en español).`;

export async function reviewComplexAnswer(settings: AiSettings, input: AnswerReviewInput): Promise<AnswerReviewVerdict | null> {
  if (input.answer.trim().length < 80) return null;
  const model = modelForTask(settings, 'complex');
  const tools = input.toolsUsed.length > 0 ? input.toolsUsed.map((t) => `${t.name}${t.success ? '' : ' (falló)'}`).join(', ') : 'ninguna';
  const res = await chatCompletion({
    model,
    temperature: 0,
    maxTokens: 1200,
    reasoningEffort: 'low',
    messages: [
      { role: 'system', content: REVIEW_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `PETICIÓN DEL USUARIO:\n${input.userMessage.slice(0, 4000)}\n\n` +
          `CONTEXTO: adjuntos=${input.hadAttachments ? 'sí' : 'no'}; documento generado=${input.documentGenerated ? 'sí' : 'no'}; herramientas=${tools}\n\n` +
          `BORRADOR DE RESPUESTA:\n${input.answer.slice(0, 24_000)}`,
      },
    ],
  });
  const parsed = parseReviewVerdict(res.content ?? '');
  if (!parsed) return null;
  return { ...parsed, model };
}
