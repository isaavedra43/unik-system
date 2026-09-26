import type { AiSettings } from './ai-admin-config-service';
import { MODEL_CATALOG, getDefaultModel, getModelById } from './model-catalog';
import { modelForTask } from './model-policy';
import type { TaskClassification } from './model-router';
import type { ProviderId, ReasoningEffort } from './providers/types';
import type { EffortLevel } from './effort-levels';

/**
 * Effort — what the user picks instead of a model ("Ultra-rápido … Ultra"),
 * the way ChatGPT and Claude let you choose how hard to think rather than
 * which engine. Each level is a real policy, not a label:
 *
 *   level    model                       reasoning  steps  tools  verification
 *   instant  fastest capable             minimal    ≤4     ≤12    none
 *   light    everyday (routine) model    low        ≤8     ≤32    1 deterministic pass
 *   medium   Jev/heuristic tier routing  per tier   admin  admin  checks + confidence escalation
 *                                                                 + review of complex answers
 *   high     strong reasoning model      high       ≥16    all    checks + review
 *   ultra    strongest available model   high       ≥24    all    checks + independent review
 *                                                                 of every substantive answer
 *
 * Every plan carries a candidate chain: when the chosen model fails (no key,
 * not enabled on the account, provider down, empty answer) the turn continues
 * on the next one instead of dying. Candidates are limited to providers that
 * are actually configured, and models whose circuit is open (see
 * model-health.ts) go last. Pure — unit tested.
 */

export {
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  effortLabel,
  parseEffort,
  type EffortLevel,
  type EffortLevelInfo,
} from './effort-levels';

export type EffortSettings = Pick<
  AiSettings,
  | 'deployment'
  | 'fallbackDeployment'
  | 'routingEnabled'
  | 'routingSimpleModel'
  | 'routingStandardModel'
  | 'routingComplexModel'
  | 'computerUseModel'
  | 'providerConfigs'
  | 'maxToolIterations'
  | 'maxToolsPerTurn'
  | 'reasoningEffort'
  | 'answerReviewEnabled'
>;

export interface EffortPlanInput {
  level: EffortLevel;
  /** A specific model the user picked (advanced): tried first, the level's chain after it. */
  explicitModel?: string | null;
  /** The agent's own default model (applies from "medio" up). */
  agentModel?: string | null;
  classification: TaskClassification;
  settings: EffortSettings;
  /** Providers with credentials. Empty = unknown (env-only install): nothing is filtered. */
  configured: ProviderId[];
  /** Which provider serves a model id (catalog → discovered → heuristics). */
  providerOf: (model: string) => ProviderId | undefined;
  /** Circuit breaker (model-health). */
  healthy?: (model: string) => boolean;
}

export interface EffortPlan {
  level: EffortLevel;
  model: string;
  /** The model first, then the fallbacks in order. */
  candidates: string[];
  /** false when the user fixed the model. */
  routed: boolean;
  /** User-facing "why this model". */
  reason: string;
  reasoningEffort: ReasoningEffort;
  /** Room for long answers (documents, analysis) regardless of the tier. */
  heavyOutput: boolean;
  /** Tool-loop rounds for a normal turn (agentic work still widens it). */
  maxIterations: number;
  maxTools: number;
  /** Deterministic verification passes over the draft (folios, totals, promises). */
  checks: number;
  /** Jev scores a standard draft; a low score re-answers on the strong model. */
  confidenceEscalation: boolean;
  /** LLM review of the draft before the user sees it. */
  review: 'never' | 'complex' | 'always';
}

const clean = (v: string | null | undefined): string => (v ?? '').trim();

function supportsVision(model: string): boolean {
  const info = getModelById(model);
  return info ? info.capabilities.includes('vision') : true;
}

function supportsTools(model: string): boolean {
  const info = getModelById(model);
  return info ? info.capabilities.includes('tool_use') : true;
}

/** Catalog models the configured providers can serve (tools required). */
function servable(input: EffortPlanInput) {
  return MODEL_CATALOG.filter(
    (m) =>
      m.available &&
      m.capabilities.includes('tool_use') &&
      (input.configured.length === 0 || input.configured.includes(m.provider))
  );
}

/** Highest power; ties prefer reasoning, then the admin's complex/primary model. */
function strongestModel(input: EffortPlanInput, preferred: string[]): string | null {
  const healthy = input.healthy ?? (() => true);
  const list = servable(input).filter((m) => healthy(m.id));
  if (list.length === 0) return null;
  const top = Math.max(...list.map((m) => m.power));
  const best = list.filter((m) => m.power === top);
  const pref = best.find((m) => preferred.includes(m.id));
  if (pref) return pref.id;
  return (best.find((m) => m.capabilities.includes('reasoning')) ?? best[0]).id;
}

/** Fastest capable model: speed "fast", decent power, cheapest on ties. */
function fastestModel(input: EffortPlanInput): string | null {
  const healthy = input.healthy ?? (() => true);
  const list = servable(input).filter((m) => m.speed === 'fast' && m.power >= 6 && healthy(m.id));
  if (list.length === 0) return null;
  list.sort(
    (a, b) =>
      b.power - a.power ||
      a.costPer1M.input + a.costPer1M.output - (b.costPer1M.input + b.costPer1M.output)
  );
  return list[0].id;
}

export function planEffort(input: EffortPlanInput): EffortPlan {
  const { level, classification: c, settings } = input;
  const policy = { ...settings, utilityModel: '', qualityJudgeModel: '' };
  const primary = clean(settings.deployment) || 'gpt-4o';
  const simple = modelForTask(policy, 'simple');
  const routine = modelForTask(policy, 'routine');
  const complex = modelForTask(policy, 'complex');
  const computer = modelForTask(policy, 'computer');
  const baseIterations = Math.max(1, Number(settings.maxToolIterations) || 10);
  const baseTools = Math.max(8, Number(settings.maxToolsPerTurn) || 96);

  let chain: string[];
  let why: string;
  let reasoningEffort: ReasoningEffort;
  let heavyOutput: boolean;
  let maxIterations: number;
  let maxTools: number;
  let checks: number;
  let confidenceEscalation = false;
  let review: EffortPlan['review'];

  switch (level) {
    case 'instant': {
      const fast = fastestModel(input);
      chain = [simple, ...(fast ? [fast] : []), routine, primary];
      why = 'Ultra-rápido: el modelo más veloz disponible';
      reasoningEffort = 'minimal';
      heavyOutput = false;
      maxIterations = Math.min(baseIterations, 4);
      maxTools = Math.min(baseTools, 12);
      checks = 0;
      review = 'never';
      break;
    }
    case 'light': {
      chain = [routine, simple, primary];
      why = 'Ligero: el modelo del día a día, rápido y económico';
      reasoningEffort = 'low';
      heavyOutput = false;
      maxIterations = Math.min(baseIterations, 8);
      maxTools = Math.min(baseTools, 32);
      checks = 1;
      review = 'never';
      break;
    }
    case 'high': {
      const strong = strongestModel(input, [complex, primary]);
      chain =
        c.computer && !supportsVision(complex)
          ? [computer, primary, complex]
          : [complex, ...(strong ? [strong] : []), primary, routine];
      why = c.computer
        ? 'Alto: modelo potente operando la computadora'
        : 'Alto: modelo de razonamiento profundo';
      reasoningEffort = c.tier === 'simple' ? 'low' : 'high';
      heavyOutput = c.tier !== 'simple';
      maxIterations = Math.max(baseIterations, 16);
      maxTools = baseTools;
      checks = 2;
      review = 'complex';
      break;
    }
    case 'ultra': {
      const strong = strongestModel(input, [complex, primary]);
      chain = [...(strong ? [strong] : []), complex, primary, routine];
      why = 'Ultra: el modelo más potente disponible con revisión independiente';
      reasoningEffort = 'high';
      heavyOutput = true;
      maxIterations = Math.max(baseIterations, 24);
      maxTools = baseTools;
      checks = 2;
      review = c.tier === 'simple' ? 'never' : 'always';
      break;
    }
    case 'medium':
    default: {
      if (c.computer) {
        chain = [computer, routine, primary];
        why = `Medio: ${c.reason} → modelo de computadora`;
      } else if (c.tier === 'simple') {
        chain = [simple, routine, primary];
        why = `Medio: ${c.reason} → modelo rápido`;
      } else if (c.tier === 'complex') {
        chain = [complex, primary, routine];
        why = `Medio: ${c.reason} → modelo potente`;
      } else {
        chain = [routine, primary, complex];
        why = `Medio: ${c.reason} → modelo del día a día`;
      }
      reasoningEffort =
        c.tier === 'complex'
          ? settings.reasoningEffort || 'high'
          : c.tier === 'simple'
            ? 'minimal'
            : 'low';
      heavyOutput = c.tier === 'complex';
      maxIterations = baseIterations;
      maxTools = baseTools;
      checks = 2;
      confidenceEscalation = true;
      review = 'complex';
      break;
    }
  }

  // The admin turned routing off: the primary model serves every level
  // (the level still shapes reasoning, steps and verification).
  if (settings.routingEnabled === false) {
    chain = [primary, ...chain];
    why = `${why.split(':')[0]}: modelo principal (ruteo desactivado)`;
  }

  const agentModel = clean(input.agentModel);
  if (agentModel && level !== 'instant' && level !== 'light') chain = [agentModel, ...chain];

  const explicit = clean(input.explicitModel);
  if (explicit) chain = [explicit, ...chain];

  // Last resorts: the admin fallback, then each configured provider's default.
  chain.push(clean(settings.fallbackDeployment));
  for (const p of input.configured) chain.push(getDefaultModel(p).id);

  // The admin's switch is company policy (cost): it wins over every level.
  if (settings.answerReviewEnabled === false && review !== 'never') {
    review = 'never';
    if (level === 'ultra')
      why = `${why.replace(' con revisión independiente', '')} (revisión desactivada por el administrador)`;
  }

  const candidates = orderCandidates(chain, input);
  const model = candidates[0] ?? explicit ?? primary;

  return {
    level,
    model,
    candidates: candidates.length > 0 ? candidates : [model],
    routed: !explicit,
    reason: explicit
      ? model === explicit
        ? 'Modelo elegido por ti'
        : `${why} (el modelo que elegiste no está disponible)`
      : why,
    reasoningEffort,
    heavyOutput,
    maxIterations,
    maxTools,
    checks,
    confidenceEscalation,
    review,
  };
}

/**
 * Dedupe, keep only models a configured provider serves (and that can use
 * tools and — when the turn has images/documents — see), healthy first.
 */
function orderCandidates(chain: string[], input: EffortPlanInput): string[] {
  const healthy = input.healthy ?? (() => true);
  const seen = new Set<string>();
  const usable: string[] = [];
  for (const raw of chain) {
    const id = clean(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const provider = input.providerOf(id);
    if (input.configured.length > 0 && (!provider || !input.configured.includes(provider)))
      continue;
    if (!supportsTools(id)) continue;
    usable.push(id);
  }
  const needsVision = input.classification.needsVision;
  const seeing = needsVision ? usable.filter(supportsVision) : usable;
  const pool = seeing.length > 0 ? seeing : usable;
  return [...pool.filter((m) => healthy(m)), ...pool.filter((m) => !healthy(m))];
}

/** Estimated USD cost of a turn from the catalog prices (null for unknown models). */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number
): number | null {
  const info = getModelById(model);
  if (!info) return null;
  const cost =
    (promptTokens / 1_000_000) * info.costPer1M.input +
    (completionTokens / 1_000_000) * info.costPer1M.output;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Display name of a model ("GPT-5", "Kimi K2.6"), the id when unknown. */
export function modelLabel(model: string): string {
  return getModelById(model)?.label ?? model;
}
