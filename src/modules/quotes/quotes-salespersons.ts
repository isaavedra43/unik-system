import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { isZohoBooksMockEnabled } from '@/modules/integrations/zoho/config';
import { listSalespersons } from '@/modules/integrations/zoho/estimates';

/**
 * Salespersons for the quote form. Source of truth is Zoho (`/salespersons`);
 * names already present in synced sales orders / invoices / quotes are merged
 * in as a fallback so the picker works before Books credentials exist.
 */

export interface SalespersonOption {
  id: string | null;
  name: string;
  email: string | null;
  source: 'zoho' | 'local';
}

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_KEY = '__unikZohoSalespersonsCache' as const;
type CacheState = { fetchedAt: number; data: SalespersonOption[] } | undefined;
type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: CacheState };

const zohoSalespersonSchema = z.object({
  salesperson_id: z.union([z.string(), z.number()]).transform(String),
  salesperson_name: z.string().min(1),
  salesperson_email: z.string().nullish(),
  is_active: z.boolean().nullish(),
}).passthrough();

function extractArray(raw: unknown): unknown[] {
  if (!raw || typeof raw !== 'object') return [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value) && key !== 'page_context') return value;
  }
  return [];
}

async function fetchZohoSalespersons(): Promise<SalespersonOption[]> {
  const raw = await listSalespersons();
  const rows: SalespersonOption[] = [];
  for (const item of extractArray(raw)) {
    const parsed = zohoSalespersonSchema.safeParse(item);
    if (!parsed.success || parsed.data.is_active === false) continue;
    rows.push({ id: parsed.data.salesperson_id, name: parsed.data.salesperson_name.trim(), email: parsed.data.salesperson_email ?? null, source: 'zoho' });
  }
  return rows;
}

async function fetchLocalSalespersons(): Promise<SalespersonOption[]> {
  const [orders, invoices, quotes] = await Promise.all([
    prisma.salesOrder.findMany({ where: { salespersonName: { not: null } }, distinct: ['salespersonName'], select: { salespersonName: true } }),
    prisma.invoice.findMany({ where: { salespersonName: { not: null } }, distinct: ['salespersonName'], select: { salespersonName: true } }),
    prisma.quote.findMany({ where: { salespersonName: { not: null } }, distinct: ['salespersonName', 'salespersonId'], select: { salespersonName: true, salespersonId: true } }),
  ]);
  const byName = new Map<string, SalespersonOption>();
  for (const q of quotes) {
    const name = q.salespersonName?.trim();
    if (name) byName.set(name.toLowerCase(), { id: q.salespersonId ?? null, name, email: null, source: 'local' });
  }
  for (const r of [...orders, ...invoices]) {
    const name = r.salespersonName?.trim();
    if (name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { id: null, name, email: null, source: 'local' });
  }
  return [...byName.values()];
}

export async function getSalespersonsForQuote(options: { forceRefresh?: boolean } = {}): Promise<SalespersonOption[]> {
  const scope = globalThis as GlobalWithCache;
  const cached = scope[CACHE_KEY];
  if (!options.forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  let zoho: SalespersonOption[] = [];
  if (!isZohoBooksMockEnabled()) {
    try {
      zoho = await fetchZohoSalespersons();
    } catch (error) {
      console.warn(JSON.stringify({ event: 'zoho.salespersons.fetch_failed', message: error instanceof Error ? error.message : 'unknown' }));
    }
  }
  const local = await fetchLocalSalespersons();

  const merged = new Map<string, SalespersonOption>();
  for (const s of zoho) merged.set(s.name.toLowerCase(), s);
  for (const s of local) if (!merged.has(s.name.toLowerCase())) merged.set(s.name.toLowerCase(), s);
  const data = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));

  // Only cache when Zoho answered (or mock mode); a failed Zoho call retries next time.
  if (zoho.length > 0 || isZohoBooksMockEnabled()) scope[CACHE_KEY] = { fetchedAt: Date.now(), data };
  return data;
}
