import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';
import { chatCompletion } from '@/modules/ai/ai-client';
import { wrapUntrusted } from '@/modules/ai/ai-guardrails';
import { modelForTask } from '@/modules/ai/model-policy';
import type { CurrentUser } from '@/modules/auth/authorization';
import { extractHtmlTitle, htmlToText } from '@/modules/copilot/knowledge-extract';
import { readConnectionSecret } from '@/modules/extensions/connections-service';
import { refreshExternalTools } from '@/modules/extensions/external-tools';
import { EgressError, isHostAllowed, safeFetch, type SafeFetchResult } from '@/modules/extensions/safe-fetch';
import { STORAGE_PURPOSES, type StoragePurpose } from '@/modules/storage/storage-keys';
import { saveGeneratedFile } from '@/modules/storage/storage-service';
import { SOURCING_EVIDENCE_PURPOSE } from './purchases-types';
import {
  RobotsGuard,
  SOURCING_USER_AGENT,
  looksLikeCaptcha,
  redirectTarget,
  turnWaitMs,
  type HostSlotStore,
} from './robots-check';
import { extractJsonObject } from './rfq-rules';
import type { SourcingConfig } from './sourcing-config';
import { dedupeCandidateDrafts, type CandidateDraft, type EvidenceEntry } from './sourcing-dedupe';
import {
  CATALOG_PAGE_TEXT_LIMIT,
  MAX_URLS_PER_SEARCH,
  buildCatalogExtractionPrompt,
  candidateExtractionSchema,
  extractionToCandidates,
  parseBraveApiResponse,
  parseBraveMcpResult,
  webResultToCandidate,
  type WebResult,
} from './sourcing-rules';

/**
 * Providers of the Sourcing Lab (plan 6.1, `sourcing-providers.ts`).
 *
 * - `brave_search`: the Brave Search MCP extension when it is installed and
 *   connected (through the common tool executor, so its approvals and limits
 *   apply); otherwise the Brave Search API through `safeFetch` with the key of
 *   the `ExtensionConnection` configured in `IntegrationConfig('sourcing')`.
 * - `catalog_page`: pages of the allowed hosts only, `robots.txt` respected,
 *   one request every 2 s per host (last request time in `UsageMeter`), every
 *   redirect re-checked against the allowlist and robots.txt, 2 MB, never a
 *   CAPTCHA; HTML → text with the knowledge extractor; candidates extracted by
 *   the `utility` model and validated by `candidateExtractionSchema`.
 *
 * Every page and raw result is stored as evidence (`sourcing_evidence`, or
 * `evidence` with that kind in the metadata while the storage purpose is not
 * registered) with its SHA-256.
 */

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'purchases-sourcing-providers', event, ...extra }));

const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const BRAVE_HOST = 'api.search.brave.com';
const EVIDENCE_TTL_DAYS = 365;
export const THROTTLE_KEY_PREFIX = 'sourcing.host:';
const MAX_CATALOG_REDIRECTS = 2;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** `sourcing_evidence` once storage registers the purpose; `evidence` (kind in metadata) until then. */
export function sourcingEvidencePurpose(purposes: readonly string[] = STORAGE_PURPOSES): StoragePurpose {
  return (purposes.includes(SOURCING_EVIDENCE_PURPOSE) ? SOURCING_EVIDENCE_PURPOSE : 'evidence') as StoragePurpose;
}

export async function saveSourcingEvidence(input: {
  createdBy: string;
  searchId: string;
  fileName: string;
  mimeType: string;
  body: Buffer | string;
  metadata?: Record<string, unknown>;
}): Promise<{ objectId: string; sha256: string } | null> {
  const buffer = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  try {
    const object = await saveGeneratedFile({
      createdBy: input.createdBy,
      purpose: sourcingEvidencePurpose(),
      fileName: input.fileName,
      mimeType: input.mimeType,
      source: { buffer },
      expiresAt: new Date(Date.now() + EVIDENCE_TTL_DAYS * 86_400_000),
      restricted: true,
      metadata: { module: 'purchases', kind: SOURCING_EVIDENCE_PURPOSE, searchId: input.searchId, sha256, ...(input.metadata ?? {}) },
    });
    return { objectId: object.id, sha256: object.sha256 ?? sha256 };
  } catch (err) {
    log('evidence_failed', { searchId: input.searchId, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Budget and throttle
// ---------------------------------------------------------------------------

/**
 * Cross-instance turns: one `UsageMeter` row per host keeps the epoch
 * milliseconds of its last granted request in `amount`. A turn is granted by a
 * conditional UPDATE (`amount <= now - interval`), atomic in PostgreSQL, so two
 * requests to a host are never closer than the interval.
 */
export const usageMeterSlotStore: HostSlotStore = {
  async claimTurn(host, intervalMs, now) {
    const key = `${THROTTLE_KEY_PREFIX}${host}`.slice(0, 190);
    const where = { dimension: 'job', key, period: 'turn', unit: 'ms' };
    const nowMs = now.getTime();
    const granted = await prisma.usageMeter.updateMany({
      where: { ...where, amount: { lte: nowMs - intervalMs } },
      data: { amount: nowMs, count: { increment: 1 } },
    });
    if (granted.count === 1) return { granted: true, waitMs: 0 };
    const row = await prisma.usageMeter.findUnique({ where: { dimension_key_period_unit: where }, select: { amount: true } });
    if (!row) {
      try {
        await prisma.usageMeter.create({ data: { ...where, amount: nowMs, count: 1 } });
        return { granted: true, waitMs: 0 };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { granted: false, waitMs: 50 };
        throw err;
      }
    }
    return { granted: false, waitMs: Math.max(50, turnWaitMs(Number(row.amount.toString()), nowMs, intervalMs)) };
  },
};

/**
 * GET of a catalog page without automatic redirects: each hop is re-checked
 * against the allowlist and robots.txt and waits its own turn of the host.
 */
async function fetchCatalogPage(
  url: string,
  robots: RobotsGuard,
  hosts: readonly string[],
  signal: AbortSignal | undefined
): Promise<{ response: SafeFetchResult } | { skipped: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_CATALOG_REDIRECTS; hop++) {
    if (hop > 0) {
      const decision = await robots.check(current);
      if (!decision.allowed) return { skipped: decision.reason };
      if (!(await robots.acquireSlot(new URL(current).hostname.toLowerCase(), decision.crawlDelayMs))) return { skipped: 'throttled' };
    }
    let location: string | null = null;
    const recordingFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const res = await fetch(input, init);
      location = res.headers.get('location');
      return res;
    }) as typeof fetch;
    try {
      const response = await safeFetch(
        current,
        { method: 'GET', headers: { 'user-agent': SOURCING_USER_AGENT, accept: 'text/html,text/plain;q=0.9' }, signal },
        {
          allowedHosts: [...hosts],
          timeoutMs: 15_000,
          maxResponseBytes: PAGE_MAX_BYTES,
          allowedContentTypes: ['text/html', 'text/plain', 'application/xhtml+xml'],
          maxRedirects: 0,
        },
        recordingFetch
      );
      return { response };
    } catch (err) {
      if (!(err instanceof EgressError) || err.code !== 'redirect') throw err;
      const next = redirectTarget(current, location, (host) => isHostAllowed(host, [...hosts]));
      if (!next) return { skipped: 'redirect_not_allowed' };
      current = next;
    }
  }
  return { skipped: 'too_many_redirects' };
}

/** Old throttle slots are useless after a minute; the hourly RFQ sweep removes them. */
export async function cleanupSourcingThrottle(before: Date): Promise<number> {
  const { count } = await prisma.usageMeter.deleteMany({
    where: { dimension: 'job', key: { startsWith: THROTTLE_KEY_PREFIX }, updatedAt: { lt: before } },
  });
  return count;
}

let guard: RobotsGuard | null = null;

export function getRobotsGuard(): RobotsGuard {
  if (!guard) {
    guard = new RobotsGuard({
      slots: usageMeterSlotStore,
      async fetchRobots(url) {
        try {
          const host = new URL(url).hostname.toLowerCase();
          const response = await safeFetch(
            url,
            { method: 'GET', headers: { 'user-agent': SOURCING_USER_AGENT, accept: 'text/plain' } },
            {
              allowedHosts: [host],
              timeoutMs: 8_000,
              maxResponseBytes: 512 * 1024,
              allowedContentTypes: ['text/plain', 'text/html', 'application/octet-stream'],
              maxRedirects: 2,
            }
          );
          return { status: response.status, body: response.body.toString('utf8') };
        } catch {
          // Unreachable robots.txt (network, egress policy): never crawl on a guess.
          return { status: null, body: '' };
        }
      },
    });
  }
  return guard;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface ProviderContext {
  searchId: string;
  /** Person who asked for the search (MCP tools run with their permissions); null for system searches. */
  actor: CurrentUser | null;
  createdBy: string;
  config: SourcingConfig;
  onProgress?: (percent: number, stage: string) => Promise<void>;
  signal?: AbortSignal;
}

export interface ProviderOutcome {
  candidates: Array<CandidateDraft & { dedupeKey: string }>;
  costUnits: number;
  rawResultObjectId: string | null;
  error: string | null;
  detail: Record<string, unknown>;
}

const NO_WEB_SEARCH =
  'No hay búsqueda web conectada: instala la extensión Brave Search (MCP) o registra la llave de Brave en la configuración del laboratorio';

export async function runBraveSearch(
  query: string,
  filters: { maxResults?: number; country?: string },
  ctx: ProviderContext
): Promise<ProviderOutcome> {
  const count = Math.min(20, Math.max(1, filters.maxResults ?? 10));
  const errors: string[] = [];
  let results: WebResult[] | null = null;
  let source: 'mcp' | 'api' | null = null;
  let raw: unknown = null;

  if (ctx.actor) {
    try {
      await refreshExternalTools();
      const [{ findWebSearchTool }, { executeTool, getExternalTools }] = await Promise.all([
        import('@/modules/extensions/web-search'),
        import('@/modules/ai/tools/registry'),
      ]);
      const toolName = findWebSearchTool(getExternalTools());
      if (toolName) {
        const execution = await executeTool(toolName, ctx.actor, { query, count }, {});
        if (execution.success) {
          raw = execution.result;
          results = parseBraveMcpResult(execution.result);
          source = 'mcp';
        } else {
          errors.push(execution.error ?? 'La búsqueda web (MCP) falló');
        }
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'La búsqueda web (MCP) falló');
    }
  }

  if (results === null && ctx.config.braveConnectionId) {
    try {
      const secret = await readConnectionSecret(ctx.config.braveConnectionId);
      const key = secret.apiKey ?? secret.accessToken;
      if (!key) throw new Error('La conexión de Brave no tiene llave de API');
      const params = new URLSearchParams({
        q: query,
        count: String(count),
        country: filters.country ?? 'MX',
        search_lang: 'es',
        safesearch: 'moderate',
      });
      const response = await safeFetch(
        `https://${BRAVE_HOST}/res/v1/web/search?${params.toString()}`,
        { method: 'GET', headers: { accept: 'application/json', 'X-Subscription-Token': key }, signal: ctx.signal },
        { allowedHosts: [BRAVE_HOST], timeoutMs: 15_000, maxResponseBytes: PAGE_MAX_BYTES, allowedContentTypes: ['application/json'], maxRedirects: 0 }
      );
      if (response.status >= 400) throw new Error(`Brave Search respondió ${response.status}`);
      raw = JSON.parse(response.body.toString('utf8'));
      results = parseBraveApiResponse(raw);
      source = 'api';
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'La búsqueda web (API) falló');
    }
  }

  if (results === null) {
    return { candidates: [], costUnits: 0, rawResultObjectId: null, error: errors[0] ?? NO_WEB_SEARCH, detail: { errors } };
  }
  await ctx.onProgress?.(60, 'Analizando resultados');
  const fetchedAt = new Date().toISOString();
  const evidence = await saveSourcingEvidence({
    createdBy: ctx.createdBy,
    searchId: ctx.searchId,
    fileName: `busqueda-${ctx.searchId}.json`,
    mimeType: 'application/json',
    body: JSON.stringify({ query, source, results, raw }),
    metadata: { provider: 'brave_search', source },
  });
  const drafts = results.slice(0, count).map((result) => webResultToCandidate(result, fetchedAt, evidence?.objectId ?? null));
  return {
    candidates: dedupeCandidateDrafts(drafts),
    costUnits: 1,
    rawResultObjectId: evidence?.objectId ?? null,
    error: null,
    detail: { source, results: results.length },
  };
}

export async function runCatalogPages(query: string, urls: readonly string[], ctx: ProviderContext): Promise<ProviderOutcome> {
  const hosts = ctx.config.allowedHosts;
  const targets = [...new Set(urls)]
    .filter((url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && isHostAllowed(parsed.hostname.toLowerCase(), hosts);
      } catch {
        return false;
      }
    })
    .slice(0, Math.min(ctx.config.maxPagesPerSearch, MAX_URLS_PER_SEARCH));
  if (targets.length === 0) {
    return {
      candidates: [],
      costUnits: 0,
      rawResultObjectId: null,
      error: 'Ninguna página está en los sitios autorizados del laboratorio',
      detail: {},
    };
  }
  const robots = getRobotsGuard();
  const drafts: CandidateDraft[] = [];
  const pages: Array<Record<string, unknown>> = [];
  let costUnits = 0;
  for (const [index, url] of targets.entries()) {
    if (ctx.signal?.aborted) break;
    await ctx.onProgress?.(10 + Math.round((index / targets.length) * 70), `Revisando ${new URL(url).hostname}`);
    const decision = await robots.check(url);
    if (!decision.allowed) {
      pages.push({ url, skipped: decision.reason });
      continue;
    }
    const host = new URL(url).hostname.toLowerCase();
    if (!(await robots.acquireSlot(host, decision.crawlDelayMs))) {
      pages.push({ url, skipped: 'throttled' });
      continue;
    }
    try {
      const fetched = await fetchCatalogPage(url, robots, hosts, ctx.signal);
      if ('skipped' in fetched) {
        pages.push({ url, skipped: fetched.skipped });
        continue;
      }
      const { response } = fetched;
      costUnits += 1;
      const body = response.body.toString('utf8');
      if (looksLikeCaptcha(response.status, body)) {
        pages.push({ url, skipped: 'captcha' });
        continue;
      }
      if (response.status >= 400) {
        pages.push({ url, status: response.status, error: `El sitio respondió ${response.status}` });
        continue;
      }
      const evidence = await saveSourcingEvidence({
        createdBy: ctx.createdBy,
        searchId: ctx.searchId,
        fileName: `pagina-${index + 1}.html`,
        mimeType: 'text/html',
        body: response.body,
        metadata: { provider: 'catalog_page', url: response.url },
      });
      const entry: EvidenceEntry = {
        url: response.url,
        fetchedAt: new Date().toISOString(),
        objectId: evidence?.objectId ?? null,
        sha256: evidence?.sha256 ?? createHash('sha256').update(response.body).digest('hex'),
      };
      const title = extractHtmlTitle(body);
      const text = htmlToText(body).slice(0, CATALOG_PAGE_TEXT_LIMIT);
      const prompt = buildCatalogExtractionPrompt({
        query,
        pageUrl: response.url,
        pageText: wrapUntrusted(`${title ?? ''}\n${text}`, 'pagina_proveedor'),
      });
      const completion = await chatCompletion({
        model: modelForTask(await getAiSettings(), 'utility'),
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: 0,
        maxTokens: 1500,
      });
      costUnits += 1;
      const parsed = candidateExtractionSchema.safeParse(extractJsonObject(completion.content));
      if (!parsed.success) {
        pages.push({ url, evidenceObjectId: entry.objectId, error: 'No se pudieron extraer proveedores de la página' });
        continue;
      }
      const found = extractionToCandidates(parsed.data, response.url, entry);
      drafts.push(...found);
      pages.push({ url, evidenceObjectId: entry.objectId, candidates: found.length });
    } catch (err) {
      pages.push({ url, error: err instanceof Error ? err.message : 'No se pudo consultar la página' });
    }
  }
  const summary = await saveSourcingEvidence({
    createdBy: ctx.createdBy,
    searchId: ctx.searchId,
    fileName: `catalogo-${ctx.searchId}.json`,
    mimeType: 'application/json',
    body: JSON.stringify({ query, pages }),
    metadata: { provider: 'catalog_page' },
  });
  const firstError = pages.find((p) => typeof p.error === 'string')?.error as string | undefined;
  const skipped = pages.find((p) => typeof p.skipped === 'string')?.skipped as string | undefined;
  const errorText =
    drafts.length === 0
      ? (firstError ??
        (skipped === 'captcha'
          ? 'El sitio pidió comprobar que no somos un robot; no se consulta'
          : skipped
            ? 'El sitio no permite consultar esas páginas (robots.txt) o está saturado'
            : null))
      : null;
  return {
    candidates: dedupeCandidateDrafts(drafts),
    costUnits,
    rawResultObjectId: summary?.objectId ?? null,
    error: errorText,
    detail: { pages },
  };
}
