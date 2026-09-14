import type { AiSettings } from './ai-admin-config-service';
import { getModelById } from './model-catalog';
import { modelForTask } from './model-policy';
import { detectDomains, normalizeText } from './tool-selector';

/**
 * Model routing by task. When the user leaves the model on "Automático" the
 * turn is classified (simple / standard / complex) and the cheapest model
 * that can do the job is used. Explicit user choices are always respected.
 * Pure classification — unit tested.
 */

export type TaskTier = 'simple' | 'standard' | 'complex';

export interface TaskClassification {
  tier: TaskTier;
  reason: string;
  needsVision: boolean;
}

export interface RoutingDecision extends TaskClassification {
  model: string;
  /** false when the user (or the admin config) fixed the model explicitly. */
  routed: boolean;
}

export interface ClassifyInput {
  message: string;
  attachmentKinds?: Array<'image' | 'document' | 'audio' | 'video' | 'other'>;
  /** The UI asked for plan-then-execute. */
  planFirst?: boolean;
  /** Auto-trigger of a copilot surface (opening a conversation, inbound message). */
  autoTrigger?: boolean;
  /** Tools used earlier in this thread (a follow-up to a data task stays standard). */
  recentToolNames?: string[];
}

/** Pseudo model id sent by the UI when the user wants automatic routing. */
export const AUTO_MODEL_ID = 'auto';

const SIMPLE_PATTERNS = [
  /^(hola|buen[oa]s?( d[ií]as| tardes| noches)?|hey|que tal|qu[eé] onda|buenas)\b/,
  /^(gracias|muchas gracias|perfecto|excelente|genial|ok|okay|va|vale|listo|dale|de acuerdo|entendido|s[ií]|no|correcto|claro|bien)\b/,
  /^(qui[eé]n eres|qu[eé] puedes hacer|qu[eé] sabes hacer|ayuda|help|c[oó]mo funcionas|qu[eé] eres)\b/,
  /^(adi[oó]s|bye|hasta luego|nos vemos|chao)\b/,
];

const COMPLEX_PATTERNS = [
  /analiz|an[aá]lisis|diagn[oó]stic|estrateg|recomiend|recomendaci|optimiz|por qu[eé]|explica|expl[ií]came|justific/,
  /compar|versus|\bvs\b|tendenc|pron[oó]stic|proyecc|predic|anomal|desviaci|correlaci/,
  /trimestr|anual|semestr|hist[oó]rico completo|todo el a[ñn]o|a[ñn]o pasado vs|mes a mes|semana a semana/,
  /plan\b|planea|paso a paso|primero .* (luego|despu[eé]s)|y (luego|despu[eé]s|adem[aá]s) .* (y|luego|despu[eé]s)/,
  /auditor|revisa todo|verifica todo|cruza|cruce|conciliaci|reconcili/,
  /extrae|extraer|\bocr\b|lee (la|el|este|esta) (factura|recibo|documento|pdf)|cr[eé]ame la bill|crea la bill/,
  /resumen ejecutivo|reporte (completo|integral|ejecutivo)|informe (completo|integral)/,
];

export function classifyTask(input: ClassifyInput): TaskClassification {
  const raw = input.message ?? '';
  const norm = normalizeText(raw);
  const kinds = input.attachmentKinds ?? [];
  const needsVision = kinds.includes('image') || kinds.includes('document');
  const domains = detectDomains(raw);
  const words = norm ? norm.split(' ').length : 0;

  if (input.planFirst) return { tier: 'complex', reason: 'plan-then-execute', needsVision };
  if (kinds.includes('document') || kinds.includes('audio') || kinds.includes('video')) {
    return { tier: 'complex', reason: 'adjunto que requiere lectura/extracción', needsVision };
  }
  if (kinds.includes('image')) return { tier: 'standard', reason: 'imagen adjunta', needsVision: true };

  if (input.autoTrigger) return { tier: 'standard', reason: 'turno automático de copiloto', needsVision };

  if (COMPLEX_PATTERNS.some((re) => re.test(norm))) {
    return { tier: 'complex', reason: 'análisis o tarea multi-paso', needsVision };
  }
  if (domains.length >= 3 || words > 70) {
    return { tier: 'complex', reason: domains.length >= 3 ? 'varios dominios en una petición' : 'petición larga', needsVision };
  }

  const hasRecentTools = (input.recentToolNames?.length ?? 0) > 0;
  if (domains.length === 0 && words <= 12 && SIMPLE_PATTERNS.some((re) => re.test(norm)) && !hasRecentTools) {
    return { tier: 'simple', reason: 'saludo / confirmación sin datos', needsVision };
  }
  if (domains.length === 0 && words <= 6 && !/\d/.test(norm) && !hasRecentTools) {
    return { tier: 'simple', reason: 'mensaje corto sin intención de datos', needsVision };
  }
  return { tier: 'standard', reason: domains.length > 0 ? `consulta de ${domains.slice(0, 2).join(' y ')}` : 'petición estándar', needsVision };
}

function modelSupportsVision(modelId: string): boolean {
  const info = getModelById(modelId);
  // Unknown ids (custom deployments) are trusted; catalog entries must declare vision.
  return info ? info.capabilities.includes('vision') : true;
}

export type RouterSettings = Pick<
  AiSettings,
  'deployment' | 'fallbackDeployment' | 'routingEnabled' | 'routingSimpleModel' | 'routingStandardModel' | 'routingComplexModel'
>;

/** Tier → model through the shared policy (simple / rutina / compleja). */
export function pickModelForTier(settings: Omit<RouterSettings, 'routingEnabled'>, tier: TaskTier): string {
  const policy = { ...settings, utilityModel: '', qualityJudgeModel: '' };
  if (tier === 'simple') return modelForTask(policy, 'simple');
  if (tier === 'complex') return modelForTask(policy, 'complex');
  return modelForTask(policy, 'routine');
}

/**
 * Final model for the turn. Explicit choices win; otherwise the tier decides.
 * A routed model that cannot see images is replaced by the primary deployment.
 */
export function resolveTurnModel(
  settings: RouterSettings,
  requestedModel: string | undefined,
  classification: TaskClassification
): RoutingDecision {
  const explicit = requestedModel && requestedModel !== AUTO_MODEL_ID ? requestedModel : undefined;
  if (explicit) return { ...classification, model: explicit, routed: false, reason: 'modelo elegido por el usuario' };
  const primary = settings.deployment?.trim() || 'gpt-4o';
  if (!settings.routingEnabled) return { ...classification, model: primary, routed: false, reason: 'routing desactivado' };
  let model = pickModelForTier(settings, classification.tier);
  if (classification.needsVision && !modelSupportsVision(model)) model = primary;
  return { ...classification, model, routed: true };
}
