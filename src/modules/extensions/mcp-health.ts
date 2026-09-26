/**
 * MCP server health — what the capability picker and the tool menu trust.
 *
 * Every connect / call outcome is recorded per extension. Two consecutive
 * transport failures (network, timeout, 5xx, auth) open the circuit: the
 * server's tools leave the model's menu until the window passes, then one
 * call is let through (half-open) and a success closes it again. A tool that
 * reports its own error (isError) is NOT a server failure.
 *
 * In memory per instance, like model-health: one failed call teaches it.
 */

export type McpFailureKind = 'network' | 'timeout' | 'auth' | 'server' | 'session' | 'other';

interface Entry {
  consecutiveFailures: number;
  openUntil: number;
  lastError: string | null;
  lastKind: McpFailureKind | null;
  lastFailureAt: number | null;
  lastOkAt: number | null;
  lastLatencyMs: number | null;
  toolCount: number | null;
}

const OPEN_AFTER = 2;
const OPEN_MS: Record<McpFailureKind, number> = {
  network: 2 * 60_000,
  timeout: 2 * 60_000,
  server: 2 * 60_000,
  session: 30_000,
  auth: 10 * 60_000,
  other: 2 * 60_000,
};

const entries = new Map<string, Entry>();

function entry(id: string): Entry {
  let e = entries.get(id);
  if (!e) {
    e = {
      consecutiveFailures: 0,
      openUntil: 0,
      lastError: null,
      lastKind: null,
      lastFailureAt: null,
      lastOkAt: null,
      lastLatencyMs: null,
      toolCount: null,
    };
    entries.set(id, e);
  }
  return e;
}

/** Classifies a transport/connect error. Pure. */
export function classifyMcpError(err: unknown): McpFailureKind {
  const e = err as { code?: unknown; message?: string; name?: string };
  const msg = (e?.message ?? String(err ?? '')).toLowerCase();
  const code = typeof e?.code === 'number' ? e.code : Number.NaN;
  if (code === 401 || code === 403 || /\b(401|403)\b|unauthori[sz]ed|forbidden/.test(msg))
    return 'auth';
  if (code === 404 || /session.{0,20}(not found|expired|invalid)/.test(msg)) return 'session';
  if (e?.name === 'AbortError' || /timeout|timed out|aborted/.test(msg)) return 'timeout';
  if ((code >= 500 && code < 600) || /\b5\d\d\b|bad gateway|service unavailable/.test(msg))
    return 'server';
  if (/fetch failed|econnrefused|enotfound|econnreset|network|socket|dns/.test(msg))
    return 'network';
  return 'other';
}

export function recordMcpSuccess(extensionId: string, latencyMs: number, toolCount?: number): void {
  const e = entry(extensionId);
  e.consecutiveFailures = 0;
  e.openUntil = 0;
  e.lastOkAt = Date.now();
  e.lastLatencyMs = Math.round(latencyMs);
  if (typeof toolCount === 'number') e.toolCount = toolCount;
}

export function recordMcpFailure(
  extensionId: string,
  err: unknown,
  now = Date.now()
): McpFailureKind {
  const kind = classifyMcpError(err);
  const e = entry(extensionId);
  e.consecutiveFailures += 1;
  e.lastKind = kind;
  e.lastFailureAt = now;
  e.lastError = (err instanceof Error ? err.message : String(err ?? '')).slice(0, 300);
  if (e.consecutiveFailures >= OPEN_AFTER || kind === 'auth') e.openUntil = now + OPEN_MS[kind];
  return kind;
}

/** false while the server's circuit is open. */
export function isMcpServerHealthy(extensionId: string, now = Date.now()): boolean {
  const e = entries.get(extensionId);
  return !e || e.openUntil <= now;
}

export type McpStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface McpHealthSnapshot {
  status: McpStatus;
  lastOkAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  lastKind: McpFailureKind | null;
  latencyMs: number | null;
  toolCount: number | null;
  retryAt: string | null;
}

export function mcpHealth(extensionId: string, now = Date.now()): McpHealthSnapshot {
  const e = entries.get(extensionId);
  if (!e) {
    return {
      status: 'unknown',
      lastOkAt: null,
      lastFailureAt: null,
      lastError: null,
      lastKind: null,
      latencyMs: null,
      toolCount: null,
      retryAt: null,
    };
  }
  const open = e.openUntil > now;
  return {
    status: open ? 'down' : e.consecutiveFailures > 0 ? 'degraded' : e.lastOkAt ? 'ok' : 'unknown',
    lastOkAt: e.lastOkAt ? new Date(e.lastOkAt).toISOString() : null,
    lastFailureAt: e.lastFailureAt ? new Date(e.lastFailureAt).toISOString() : null,
    lastError: e.lastError,
    lastKind: e.lastKind,
    latencyMs: e.lastLatencyMs,
    toolCount: e.toolCount,
    retryAt: open ? new Date(e.openUntil).toISOString() : null,
  };
}

/** Human explanation for the picker / diagnostics. */
export function describeMcpFailure(kind: McpFailureKind | null): string {
  switch (kind) {
    case 'auth':
      return 'El servidor rechazó las credenciales: vuelve a conectar la cuenta.';
    case 'timeout':
      return 'El servidor no respondió a tiempo.';
    case 'network':
      return 'No se pudo llegar al servidor.';
    case 'server':
      return 'El servidor tuvo una falla interna.';
    case 'session':
      return 'La sesión con el servidor expiró; se reconecta sola.';
    default:
      return 'El servidor falló.';
  }
}

/** Test hook. */
export function resetMcpHealth(): void {
  entries.clear();
}
