import { createHash } from 'crypto';
import { jevDecide, JevError } from './jev-client';
import type { JevAnswers, JevQuestion } from './jev-client';
import { getAiSettings } from '../ai-admin-config-service';

/**
 * Decision engine — the cheap nervous system of the assistant.
 *
 * Every "does this need X?" question that would otherwise cost a full LLM call
 * (or a fragile regex) goes through here. Jev answers typed questions with
 * calibrated probabilities in a single request; when it is disabled, down or
 * unconfident, `decide` returns null and the call site uses its declared
 * fallback — Jev accelerates, it is never a single point of failure.
 */

export interface DecideOptions {
  /** Audit correlation. */
  userId?: string;
  conversationId?: string;
  /** Skip the 60s cache (state is already known to be fresh/volatile). */
  bypassCache?: boolean;
  timeoutMs?: number;
}

export interface DecisionResult {
  answers: JevAnswers;
  /** true when the answer came from the in-memory cache. */
  cached: boolean;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Cache: identical state+questions within 60s reuse the answer (retries in the
// same turn, batch checks over the same page...). Bounded, FIFO eviction.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;
const cache = new Map<string, { answers: JevAnswers; at: number }>();

function cacheKey(state: unknown, questions: Record<string, JevQuestion>, model: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ s: state, q: questions, m: model }))
    .digest('hex')
    .slice(0, 32);
}

function cacheGet(key: string): JevAnswers | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.answers;
}

function cacheSet(key: string, answers: JevAnswers): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { answers, at: Date.now() });
}

/** Test hook. */
export function clearDecisionCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface DecisionSettings {
  enabled: boolean;
  model: string;
  minConfidence: number;
}

let settingsMemo: { value: DecisionSettings; at: number } | null = null;

async function decisionSettings(): Promise<DecisionSettings> {
  if (settingsMemo && Date.now() - settingsMemo.at < 10_000) return settingsMemo.value;
  let value: DecisionSettings = { enabled: false, model: 'typesafe/jev-1.13', minConfidence: 0.7 };
  try {
    const s = await getAiSettings();
    value = {
      enabled: s.jevEnabled === true,
      model: s.jevModel?.trim() || 'typesafe/jev-1.13',
      minConfidence: Math.max(0, Math.min(1, Number(s.jevMinConfidence) || 0.7)),
    };
  } catch {
    // settings unavailable (tests, early boot): keep defaults — disabled
  }
  settingsMemo = { value, at: Date.now() };
  return value;
}

/** Test hook. */
export function resetDecisionSettingsCache(): void {
  settingsMemo = null;
}

// ---------------------------------------------------------------------------
// decide() — never throws
// ---------------------------------------------------------------------------

/**
 * Asks Jev the given typed questions about `state`. Returns null when Jev is
 * disabled, misconfigured, down, or the response is unusable — the caller then
 * falls back to its heuristic or to the utility LLM.
 */
export async function decide(
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: DecideOptions = {}
): Promise<DecisionResult | null> {
  const settings = await decisionSettings();
  if (!settings.enabled) return null;

  const key = cacheKey(state, questions, settings.model);
  if (!opts.bypassCache) {
    const hit = cacheGet(key);
    if (hit) return { answers: hit, cached: true, durationMs: 0 };
  }

  try {
    const result = await jevDecide(state, questions, {
      model: settings.model,
      timeoutMs: opts.timeoutMs,
      userId: opts.userId,
      conversationId: opts.conversationId,
    });
    cacheSet(key, result.answers);
    return { answers: result.answers, cached: false, durationMs: result.durationMs };
  } catch (err) {
    if (!(err instanceof JevError && err.code === 'no_key')) {
      console.warn(
        '[decisions] Jev call failed:',
        err instanceof Error ? `${err.message}` : String(err)
      );
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Answer helpers — return null when missing or under the confidence floor, so
// the call site can tell "Jev said no" from "Jev didn't answer".
// ---------------------------------------------------------------------------

/**
 * Yes/no answer above the confidence floor. The floor applies to whichever side
 * wins: p≥t means "yes", p≤1-t means "no", anything between is inconclusive
 * (null → fallback).
 */
export function answerBool(
  result: DecisionResult | null,
  key: string,
  minConfidence?: number
): boolean | null {
  const answer = result?.answers[key];
  if (!answer || answer.type !== 'noul') return null;
  const t = minConfidence ?? settingsMemo?.value.minConfidence ?? 0.7;
  if (answer.noul >= t) return true;
  if (answer.noul <= 1 - t) return false;
  return null;
}

/** Raw noul probability for callers that want the number itself. */
export function answerProbability(result: DecisionResult | null, key: string): number | null {
  const answer = result?.answers[key];
  return answer && answer.type === 'noul' ? answer.noul : null;
}

/** Picked option when its confidence clears the floor (missing confidence = accept). */
export function answerChoice(
  result: DecisionResult | null,
  key: string,
  allowed?: readonly string[],
  minConfidence?: number
): string | null {
  const answer = result?.answers[key];
  if (!answer || answer.type !== 'choice') return null;
  if (allowed && !allowed.includes(answer.choice)) return null;
  const t = minConfidence ?? settingsMemo?.value.minConfidence ?? 0.7;
  if (answer.confidence !== undefined && answer.confidence < t) return null;
  return answer.choice;
}

/** Rubric position (0..1 scale normalized by rubric size), or null under floor. */
export function answerScore(
  result: DecisionResult | null,
  key: string,
  rubricSize: number,
  minConfidence?: number
): number | null {
  const answer = result?.answers[key];
  if (!answer || answer.type !== 'score') return null;
  const t = minConfidence ?? settingsMemo?.value.minConfidence ?? 0.7;
  if (answer.confidence !== undefined && answer.confidence < t) return null;
  // Score is a position on the rubric: normalize to 0..1 by its size.
  const normalized = rubricSize > 1 ? answer.score / (rubricSize - 1) : answer.score;
  return Math.max(0, Math.min(1, normalized));
}
