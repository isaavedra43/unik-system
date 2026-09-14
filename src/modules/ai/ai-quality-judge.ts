import { chatCompletion } from './ai-client';
import { getAiSettings } from './ai-admin-config-service';
import { mergeMessageMeta } from './ai-sessions-service';
import { modelForTask } from './model-policy';

/**
 * Optional automatic quality evaluation ("LLM as judge"). Runs AFTER the answer
 * was delivered, never blocks the user, and stores a 1-5 score plus issues in
 * `AiMessage.meta.judge` for the admin dashboard. Enabled by the admin
 * (`qualityJudgeEnabled`); uses a cheap model by default.
 */

export interface JudgeInput {
  messageId: string;
  userMessage: string;
  answer: string;
  toolsUsed: Array<{ name: string; success: boolean; cached?: boolean }>;
  confidence: string | null;
}

export interface JudgeVerdict {
  score: number;
  issues: string[];
  summary: string;
  model: string;
  at: string;
}

export function parseJudgeVerdict(text: string): { score: number; issues: string[]; summary: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { score?: unknown; issues?: unknown; summary?: unknown };
    const score = Math.max(1, Math.min(5, Math.round(Number(parsed.score))));
    if (!Number.isFinite(score)) return null;
    const issues = Array.isArray(parsed.issues) ? parsed.issues.filter((i): i is string => typeof i === 'string').slice(0, 6) : [];
    return { score, issues, summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 300) : '' };
  } catch {
    return null;
  }
}

export async function judgeTurnQuality(input: JudgeInput): Promise<JudgeVerdict | null> {
  const settings = await getAiSettings();
  if (!settings.qualityJudgeEnabled) return null;
  if (input.answer.trim().length < 40) return null;
  const model = modelForTask(settings, 'judge');
  const tools = input.toolsUsed.length > 0 ? input.toolsUsed.map((t) => `${t.name}${t.success ? '' : ' (falló)'}${t.cached ? ' (caché)' : ''}`).join(', ') : 'ninguna';
  const res = await chatCompletion({
    model,
    temperature: 0,
    maxTokens: 300,
    messages: [
      {
        role: 'system',
        content:
          'Eres un evaluador de calidad de respuestas de un asistente empresarial (ERP). Califica de 1 a 5 considerando: (a) responde lo que se pidió, (b) usa datos de herramientas cuando hacía falta y no inventa, (c) es clara y accionable, (d) declara su nivel de confianza si hay cifras. Responde SOLO JSON: {"score": 1-5, "issues": ["..."], "summary": "una frase"}.',
      },
      {
        role: 'user',
        content: `Pregunta del usuario:\n${input.userMessage.slice(0, 1500)}\n\nHerramientas usadas: ${tools}\nEtiqueta de confianza: ${input.confidence ?? 'ninguna'}\n\nRespuesta del asistente:\n${input.answer.slice(0, 4000)}`,
      },
    ],
  });
  const verdict = parseJudgeVerdict(res.content ?? '');
  if (!verdict) return null;
  const full: JudgeVerdict = { ...verdict, model, at: new Date().toISOString() };
  await mergeMessageMeta(input.messageId, { judge: full });
  return full;
}
