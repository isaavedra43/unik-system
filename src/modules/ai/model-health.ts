/**
 * Model health — a per-instance circuit breaker for chat models.
 *
 * When a model fails (bad key, model not enabled on the account, provider
 * down, empty answers) the turn falls back to the next candidate, and the
 * failing model stays "open" for a while so the next turns skip it instead
 * of failing the same way first. Config errors (auth / not found) stay open
 * longer than transient ones (5xx, timeouts, rate limits).
 *
 * In memory on purpose: each Railway instance learns on its own in one
 * failed call, and a redeploy starts clean.
 */

export type ModelFailureKind =
  'auth' | 'not_found' | 'rate_limit' | 'timeout' | 'server' | 'empty' | 'unknown';

interface HealthEntry {
  failures: number;
  openUntil: number;
  lastError: string;
  lastKind: ModelFailureKind;
  lastFailureAt: number;
}

const OPEN_MS: Record<ModelFailureKind, number> = {
  auth: 30 * 60_000,
  not_found: 30 * 60_000,
  rate_limit: 60_000,
  timeout: 2 * 60_000,
  server: 2 * 60_000,
  empty: 5 * 60_000,
  unknown: 3 * 60_000,
};

const entries = new Map<string, HealthEntry>();

/** Classifies a provider error into a failure kind. Pure. */
export function classifyModelError(err: unknown): ModelFailureKind {
  const e = err as { code?: string; httpStatus?: number; status?: number; message?: string };
  const status = e?.httpStatus ?? e?.status;
  const msg = (e?.message ?? String(err ?? '')).toLowerCase();
  if (e?.code === 'auth' || status === 401 || status === 403) return 'auth';
  if (
    status === 404 ||
    /model.{0,40}(not found|does not exist|not exist|no existe|unavailable|not available|not supported)|unknown model|invalid model|no endpoints found/.test(
      msg
    )
  )
    return 'not_found';
  if (e?.code === 'rate_limit' || status === 429) return 'rate_limit';
  if (e?.code === 'timeout' || /timeout|timed out|etimedout|aborted/.test(msg)) return 'timeout';
  if (e?.code === 'server' || (typeof status === 'number' && status >= 500)) return 'server';
  if (/empty answer|respuesta vac/.test(msg)) return 'empty';
  return 'unknown';
}

export function reportModelFailure(
  model: string,
  err: unknown,
  now = Date.now()
): ModelFailureKind {
  const kind = classifyModelError(err);
  const prev = entries.get(model);
  const failures = (prev?.failures ?? 0) + 1;
  // Repeated transient failures back off longer (×2 each, capped at 30 min).
  const base = OPEN_MS[kind];
  const openMs = Math.min(30 * 60_000, base * 2 ** Math.min(4, failures - 1));
  entries.set(model, {
    failures,
    openUntil: now + openMs,
    lastError: (err instanceof Error ? err.message : String(err ?? '')).slice(0, 300),
    lastKind: kind,
    lastFailureAt: now,
  });
  return kind;
}

export function reportModelSuccess(model: string): void {
  entries.delete(model);
}

/** false while the model's circuit is open (recent failure). */
export function isModelHealthy(model: string, now = Date.now()): boolean {
  const e = entries.get(model);
  return !e || e.openUntil <= now;
}

export interface ModelHealthSnapshot {
  model: string;
  healthy: boolean;
  failures: number;
  lastKind: ModelFailureKind;
  lastError: string;
  retryAt: string | null;
}

/** Diagnostics for the model picker / admin: which models are failing and why. */
export function modelHealthSnapshot(now = Date.now()): ModelHealthSnapshot[] {
  return [...entries.entries()].map(([model, e]) => ({
    model,
    healthy: e.openUntil <= now,
    failures: e.failures,
    lastKind: e.lastKind,
    lastError: e.lastError,
    retryAt: e.openUntil > now ? new Date(e.openUntil).toISOString() : null,
  }));
}

/** Test hook. */
export function resetModelHealth(): void {
  entries.clear();
}

/** Human reason for the UI ("GPT-5 no respondió: llave sin acceso"). */
export function describeFailure(kind: ModelFailureKind): string {
  switch (kind) {
    case 'auth':
      return 'la llave del proveedor no tiene acceso';
    case 'not_found':
      return 'el modelo no está disponible en tu cuenta';
    case 'rate_limit':
      return 'límite de uso del proveedor';
    case 'timeout':
      return 'no respondió a tiempo';
    case 'server':
      return 'el proveedor tuvo una falla';
    case 'empty':
      return 'devolvió una respuesta vacía';
    default:
      return 'falló';
  }
}
