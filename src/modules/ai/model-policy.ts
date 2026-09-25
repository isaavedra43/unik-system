import type { AiSettings } from './ai-admin-config-service';
import { getModelById } from './model-catalog';

/**
 * Model policy: ONE place that decides which model serves each kind of work,
 * so the admin can put the daily, high-volume traffic on the flat-rate
 * provider (Canopy Wave) and keep the expensive one (OpenAI) for complex
 * turns. Every background caller (summaries, digests, judge, inbox drafts,
 * call summaries…) asks `modelForTask` instead of hard-coding a setting.
 *
 * Tasks:
 * - simple   → greetings / confirmations (assistant turns classified as simple)
 * - routine  → everyday data questions and actions (assistant turns "standard")
 * - complex  → analysis, documents, multi-step plans (assistant turns "complex")
 * - utility  → background one-shot calls: conversation summaries, work digests,
 *              inbox/chat drafts and summaries, call copilot + call summaries, re-ranking
 * - judge    → automatic quality scoring
 * - vision   → structured extraction from images/PDF (must see)
 * - computer → computer use on the virtual venue: navigate, click, type, exec,
 *              read screens (needs tools; vision strongly recommended). The
 *              default is Gemini 2.5 Flash through OpenRouter — the best
 *              quality/price model in the catalog for agentic browsing — only
 *              when an OpenRouter key exists; otherwise the routine model.
 *
 * Empty settings fall back in this order: task-specific → routine → primary
 * (`deployment`), so an unconfigured install behaves exactly as before.
 */

export type AiTask = 'simple' | 'routine' | 'complex' | 'utility' | 'judge' | 'vision' | 'computer';

/** Cheapest capable computer-use model in the catalog (vision + tools + 1M ctx). */
export const COMPUTER_USE_DEFAULT_MODEL = 'google/gemini-2.5-flash';

export type ModelPolicySettings = Pick<
  AiSettings,
  | 'deployment'
  | 'fallbackDeployment'
  | 'routingSimpleModel'
  | 'routingStandardModel'
  | 'routingComplexModel'
  | 'utilityModel'
  | 'qualityJudgeModel'
  | 'computerUseModel'
  | 'providerConfigs'
>;

const clean = (value: string | undefined | null): string => (value ?? '').trim();

function supportsVision(modelId: string): boolean {
  const info = getModelById(modelId);
  // Unknown ids (custom deployments) are trusted; catalog entries must declare vision.
  return info ? info.capabilities.includes('vision') : true;
}

export function modelForTask(settings: ModelPolicySettings, task: AiTask): string {
  const primary = clean(settings.deployment) || 'gpt-4o';
  const routine = clean(settings.routingStandardModel) || primary;
  switch (task) {
    case 'simple':
      return clean(settings.routingSimpleModel) || clean(settings.fallbackDeployment) || routine;
    case 'routine':
      return routine;
    case 'complex':
      return clean(settings.routingComplexModel) || primary;
    case 'utility':
      return clean(settings.utilityModel) || clean(settings.routingSimpleModel) || routine;
    case 'judge':
      return clean(settings.qualityJudgeModel) || modelForTask(settings, 'utility');
    case 'vision': {
      const preferred = modelForTask(settings, 'complex');
      if (supportsVision(preferred)) return preferred;
      return supportsVision(primary) ? primary : preferred;
    }
    case 'computer': {
      const configured = clean(settings.computerUseModel) || clean(process.env.UNIK_COMPUTER_MODEL);
      if (configured) return configured;
      // OpenRouter reachable → the fast+cheap vision agentic model; otherwise
      // the everyday tier so venue turns still work without an OR key.
      const entry = settings.providerConfigs?.openrouter;
      const orReady =
        Boolean(clean(process.env.OPENROUTER_API_KEY)) ||
        Boolean(entry?.enabled && clean(entry?.apiKey));
      return orReady ? COMPUTER_USE_DEFAULT_MODEL : routine;
    }
    default:
      return primary;
  }
}

export const AI_TASK_LABELS: Record<AiTask, { label: string; description: string }> = {
  simple: {
    label: 'Tareas simples',
    description: 'Saludos, confirmaciones, aclaraciones sin datos.',
  },
  routine: {
    label: 'Rutina diaria',
    description:
      'Consultas y acciones del día a día: ventas, clientes, cotizaciones, mensajes, bandeja, chat.',
  },
  complex: {
    label: 'Tareas complejas',
    description:
      'Análisis, comparaciones, reportes ejecutivos, documentos adjuntos, planes multi-paso.',
  },
  utility: {
    label: 'Procesos de fondo',
    description:
      'Resúmenes de hilos y llamadas, digest diario, borradores de bandeja/chat, re-ranking.',
  },
  judge: { label: 'Juez de calidad', description: 'Califica cada respuesta (si está activado).' },
  vision: {
    label: 'Lectura de documentos',
    description: 'Extracción de datos de facturas/recibos (necesita visión).',
  },
  computer: {
    label: 'Computadora virtual',
    description:
      'Computer use: navegar, hacer clic, escribir y leer pantallas en la computadora virtual. Vacío = Gemini 2.5 Flash vía OpenRouter (rápido y barato) si hay llave; si no, el modelo de rutina.',
  },
};
