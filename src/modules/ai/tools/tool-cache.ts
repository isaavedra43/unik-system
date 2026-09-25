import { createHash } from 'crypto';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { ToolDefinition } from './registry';

/**
 * Short-TTL cache for READ tool results.
 *
 * Two users asking "ventas de hoy" within 30 seconds hit the database once.
 * Rules:
 * - Only built-in tools with effect `read` in data categories are cached.
 * - Pure data tools (SHARED_CACHE_TOOLS) share entries between users with the
 *   SAME permission set; every other cacheable tool is cached per user.
 * - "Live" queries (today / this week / no period) expire fast; closed periods
 *   (last month, last year, explicit past dates) live longer.
 * - Any successful side-effecting tool clears the whole cache.
 * Values are stored serialized so cached results are never mutated in place.
 */

interface CacheEntry {
  json: string;
  storedAt: number;
  expiresAt: number;
}

export class ToolResultCache {
  private readonly entries = new Map<string, CacheEntry>();
  hits = 0;
  misses = 0;

  constructor(private readonly maxEntries = 400) {}

  get size(): number {
    return this.entries.size;
  }

  get<T = unknown>(key: string, now = Date.now()): { value: T; storedAt: number } | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    // LRU touch
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { value: JSON.parse(entry.json) as T, storedAt: entry.storedAt };
  }

  set(key: string, value: unknown, ttlMs: number, now = Date.now()): void {
    if (ttlMs <= 0) return;
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      return;
    }
    if (json.length > MAX_CACHED_BYTES) return;
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { json, storedAt: now, expiresAt: now + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  prune(now = Date.now()): void {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}

const MAX_CACHED_BYTES = 512 * 1024;

export const toolResultCache = new ToolResultCache();

/** Categories whose read tools may be cached at all. */
export const CACHEABLE_CATEGORIES: ReadonlySet<string> = new Set([
  'sales',
  'finance',
  'inventory',
  'purchases',
  'payments',
  'invoices',
  'packages',
  'products',
  'contacts',
  // Web reads cache with the live TTL — same query twice in a minute = same
  // answer, and it is what makes Jev prefetch possible for internet requests.
  'web',
]);

/** Pure data tools: same permissions ⇒ same answer, so entries are shared between users. */
export const SHARED_CACHE_TOOLS: ReadonlySet<string> = new Set([
  'querySalesOrders',
  'getSalesOrderDetail',
  'getTopProducts',
  'getSalesTrend',
  'getSalesRanking',
  'getHourlySalesPattern',
  'getWeekdaySalesPattern',
  'getOrdersWithBalance',
  'auditPendingDeliveries',
  'getCashCloseReconciliation',
  'findProductRelations',
  'getProductCatalog',
  'getStockMovement',
  'getLowStockAlerts',
  'getProductDetails',
  'getProductSearch',
  'getTopCustomers',
  'getCustomerDetails',
  'getCustomerSegments',
  'getCustomerRetention',
  'getAccountsReceivable',
  'getRevenueAnalysis',
  'getDailyRevenue',
  'getBalanceAging',
  'comparePeriods',
  'getSalesKPIs',
  'getDashboardSummary',
  'getCrossTabAnalysis',
  'compareEntities',
  'getTeamPerformance',
  'getSalesForecast',
  'getSalesAlerts',
  'getSalesVelocity',
  'getProductBundles',
  'queryPurchaseOrders',
  'getPurchaseOrderDetail',
  'queryBills',
  'getBillDetail',
  'queryVendorCredits',
  'getVendorCreditDetail',
  'queryPayments',
  'getPaymentDetail',
  'queryInvoices',
  'getInvoiceDetail',
  'queryPackages',
  'getPackageDetail',
  'queryProducts',
  'getProductDetail',
  'queryContacts',
  'getContactDetail',
  'queryQuotes',
  'getQuoteDetail',
  'searchQuoteCustomers',
  'searchQuoteProducts',
  'findSimilarPastQuotes',
  'checkStockForRequest',
  'getCustomerPriceHistory',
  'getCustomerHealth',
  'getOrderItems',
]);

/** Never cached: results depend on the moment, on the user's own state, or are remote/expensive to keep. */
const NO_CACHE_TOOLS: ReadonlySet<string> = new Set([
  'getContactFile', // live Zoho call, user-facing freshness matters
  'getQuotePdf',
  'previewQuote',
  'getSystemTime',
  'getNotifications',
]);

export function isCacheableTool(tool: Pick<ToolDefinition, 'name' | 'effect' | 'source' | 'category'>): boolean {
  if ((tool.source ?? 'builtin') !== 'builtin') return false;
  if ((tool.effect ?? 'read') !== 'read') return false;
  if (NO_CACHE_TOOLS.has(tool.name)) return false;
  return CACHEABLE_CATEGORIES.has(tool.category) || SHARED_CACHE_TOOLS.has(tool.name);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Cache key: tool + args + permission set (+ user for non-shared tools). Conversation ids are ignored. */
export function cacheKeyFor(tool: Pick<ToolDefinition, 'name'>, actor: CurrentUser, args: unknown): string {
  const cleanArgs = { ...((args && typeof args === 'object' ? args : {}) as Record<string, unknown>) };
  delete cleanArgs.conversationId;
  const perms = [...actor.permissionKeys].sort().join('|');
  const scope = SHARED_CACHE_TOOLS.has(tool.name) ? `perm:${sha1(`${actor.isSuperAdmin ? 'sa' : ''}:${perms}`)}` : `user:${actor.id}`;
  // tenantId en la key: el caché compartido jamás cruza empresas.
  return `t:${actor.tenantId ?? 'unik'}:${tool.name}:${scope}:${sha1(stableStringify(cleanArgs))}`;
}

const HISTORICAL_RANGES = new Set(['last_month', 'last_year', 'last_quarter', 'previous_month', 'previous_year', 'all', 'historic', 'historico']);
const LIVE_RANGES = new Set(['today', 'yesterday', 'this_week', 'this_month', 'this_year', 'last_7_days', 'last_30_days', 'last_90_days']);

function isPastDate(value: unknown, now: Date): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d < startOfToday;
}

/**
 * TTL by "how alive" the requested data is. A closed period (last month, an
 * explicit past date range) can be cached longer than "today".
 */
export function ttlForArgs(args: unknown, liveMs: number, historicalMs: number, now = new Date()): number {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const range = typeof a.dateRange === 'string' ? a.dateRange : typeof a.period === 'string' ? a.period : null;
  if (range) {
    if (HISTORICAL_RANGES.has(range)) return historicalMs;
    if (LIVE_RANGES.has(range)) return liveMs;
  }
  const to = a.endDate ?? a.dateTo ?? a.to ?? a.until;
  const from = a.startDate ?? a.dateFrom ?? a.from ?? a.since;
  if (to !== undefined && isPastDate(to, now)) return historicalMs;
  if (from !== undefined && to === undefined && isPastDate(from, now) && !range) return liveMs;
  return liveMs;
}
