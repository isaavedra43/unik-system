import type { CurrentUser } from '@/modules/auth/authorization';
import type { ToolDefinition } from './tools/registry';
import { decide, answerChoice } from './decisions/decision-engine';
import {
  prefetchPickDecision,
  PREFETCH_CHOICES,
  PREFETCH_PERIODS,
  type PrefetchChoice,
  type PrefetchPeriod,
} from './decisions/decision-points';
import { isCacheableTool } from './tools/tool-cache';

/**
 * Turn prefetch — Jev predicts the ONE read the model will almost surely call
 * and the orchestrator warms the shared read cache while the first model call
 * is still in flight. "¿Cuánto vendí hoy?" starts with the query already running;
 * when the model then calls querySalesOrders({dateRange:"today"}) — the exact
 * canonical call it was taught — it gets a cached result in ~0 ms.
 *
 * Safety: only built-in read tools that are cacheable; never when the user
 * asked for live data (the cache would be bypassed anyway); never for tools
 * the actor can't see. A wrong pick costs one cheap DB query, nothing else —
 * the cache key is args-exact, so a mismatched call simply misses.
 */

/** "hola, busca en internet arena de gato en amazon" → "arena de gato en amazon". */
function cleanWebQuery(message: string): string {
  const q = message
    .replace(/^\s*(hola|buenas?|hey|hi|oye|oiga)[,!.]*/i, '')
    .replace(/\b(busca(r|me|nos)?|encuentra|investiga|mira|revisa(r|me)?|dime|quiero|necesito|hazme|por favor|porfa|porfis)\b/gi, ' ')
    .replace(/\b(en|por)\s+(internet|la web|google|la red|l[íi]nea|amazon|mercado\s?libre)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return q.length >= 3 ? q : message.trim();
}

const CANONICAL: Record<Exclude<PrefetchChoice, 'none'>, (period: PrefetchPeriod | null, message: string) => { name: string; args: Record<string, unknown> }> = {
  sales_period: (p) => ({ name: 'querySalesOrders', args: { dateRange: p && p !== 'none' ? p : 'today' } }),
  business_summary: (p) => ({ name: 'getDashboardSummary', args: { dateRange: p && p !== 'none' ? p : 'today' } }),
  accounts_receivable: () => ({ name: 'getAccountsReceivable', args: {} }),
  low_stock: (p) => ({ name: 'getLowStockAlerts', args: { dateRange: p && p !== 'none' ? p : 'this_month' } }),
  top_products: (p) => ({ name: 'getTopProducts', args: { dateRange: p && p !== 'none' ? p : 'this_month' } }),
  // Web search is canonicalized from the message itself — the model's own
  // web_search call only hits cache when it uses the same query string, which
  // is exactly what this stripper approximates.
  web_query: (_p, message) => ({ name: 'web_search', args: { query: cleanWebQuery(message) } }),
};

export interface PrefetchResult {
  tool: string;
  warmed: boolean;
  cached: boolean;
}

/**
 * Picks and runs the predicted read. Awaits the tool so the caller controls
 * concurrency (the orchestrator fires it alongside the model call); returns
 * what was warmed for logging/tests.
 */
export async function prefetchLikelyRead(
  message: string,
  actor: CurrentUser,
  offeredTools: ToolDefinition[],
  ctx: { userId?: string; conversationId?: string; enabledToolNames?: string[] } = {}
): Promise<PrefetchResult | null> {
  const candidates = new Map(
    offeredTools
      .filter((t) => (t.source ?? 'builtin') === 'builtin' && (t.effect ?? 'read') === 'read' && isCacheableTool(t))
      .map((t) => [t.name, t] as const)
  );
  if (candidates.size === 0) return null;

  const { state, questions } = prefetchPickDecision(message);
  const result = await decide(state, questions, ctx).catch(() => null);
  if (!result) return null;

  const pick = answerChoice(result, 'read', PREFETCH_CHOICES) as PrefetchChoice | null;
  if (!pick || pick === 'none') return null;
  const period = answerChoice(result, 'period', PREFETCH_PERIODS) as PrefetchPeriod | null;
  const call = CANONICAL[pick]?.(period, message);
  if (!call || !candidates.has(call.name)) return null;

  const { executeTool } = await import('./tools/registry');
  const exec = await executeTool(call.name, actor, call.args, {
    conversationId: ctx.conversationId,
    enabledToolNames: ctx.enabledToolNames,
  }).catch(() => null);
  if (!exec) return { tool: call.name, warmed: false, cached: false };
  return { tool: call.name, warmed: exec.success, cached: Boolean(exec.cached) };
}
