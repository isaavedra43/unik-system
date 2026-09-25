import { z } from 'zod';
import { registerTool } from './registry';
import { getAiSettings } from '../ai-admin-config-service';
import { getSearchProvider } from '@/modules/web/search-provider';
import { fetchWebPage, isUrlDenied } from '@/modules/web/fetch-service';
import { recordUsage } from '@/modules/extensions/usage-meter';

/**
 * `web_research` — the bounded research loop as ONE tool call.
 *
 * The model can't call web_search 40 times in a turn (iteration + latency
 * limits), so large research ("analiza 100 publicaciones") collapses without
 * this. The tool runs the whole pipeline server-side: fan out the queries,
 * dedupe by URL, fetch the strongest pages, and return a structured corpus
 * with provenance per source. The model's job is reduced to what it's good
 * at: asking the right queries and synthesizing the corpus with citations.
 *
 * Honesty contract baked into the result: `sources[]` is the COMPLETE list of
 * pages actually fetched — the model may only cite those URLs. `failed[]`
 * lists what could not be read so the report can disclose coverage honestly.
 *
 * For workloads beyond one call (100+ sources), the note tells the model to
 * propose a mission whose steps run this tool in batches.
 */

const MAX_QUERIES = 6;
const MAX_PAGES = 20;
const EXCERPT_CHARS = 2_800;
const RESULTS_PER_QUERY = 10;
const FETCH_DEADLINE_MS = 150_000;

registerTool({
  name: 'web_research',
  description:
    'Investigación web de una llamada: ejecuta varias búsquedas, deduplica URLs, lee las páginas más relevantes y devuelve un corpus con fuentes citables (url, título, extracto). Para investigaciones grandes (ej. 100 publicaciones), llama varias veces o propone una misión por lotes.',
  category: 'web',
  enabledByDefault: false,
  requiredPermission: 'web.search',
  resultTrust: 'untrusted',
  timeoutMs: FETCH_DEADLINE_MS + 20_000,
  maxResultBytes: 120_000,
  contextTags: ['all'],
  isAvailable: async () => {
    const s = await getAiSettings();
    return s.webSearchEnabled && s.webFetchEnabled;
  },
  parameters: z.object({
    goal: z.string().min(5).max(500).describe('Qué se investiga, ej. "publicaciones que venden arena para gato y por qué funcionan".'),
    queries: z
      .array(z.string().min(2).max(300))
      .min(1)
      .max(MAX_QUERIES)
      .describe('Hasta 6 búsquedas variadas (diferentes idiomas/ángulos para mejor cobertura).'),
    maxPages: z.number().int().min(1).max(MAX_PAGES).optional().describe('Páginas a leer (default 8, máx 20 por llamada).'),
    topic: z.enum(['general', 'news']).optional(),
  }),
  summarize: (a) => `Investigar en la web: "${String((a as { goal?: string }).goal ?? '').slice(0, 80)}"`,
  execute: async (actor, args, ctx) => {
    const a = args as { goal: string; queries: string[]; maxPages?: number; topic?: 'general' | 'news' };
    const provider = await getSearchProvider();
    if (!provider) {
      return { error: 'Búsqueda web no configurada. Activa Tavily en Asistente IA → Internet.', sources: [] };
    }
    const settings = await getAiSettings();
    const allowlist = (settings.webDomainAllowlist ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
    const denylist = (settings.webDomainDenylist ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);

    // 1) Fan-out search.
    const hitCount = new Map<string, number>();
    const meta = new Map<string, { title?: string; snippet?: string }>();
    for (const q of a.queries.slice(0, MAX_QUERIES)) {
      try {
        const outcome = await provider.search({ query: q, maxResults: RESULTS_PER_QUERY, topic: a.topic });
        await recordUsage('web', actor.id, 'search_query', 1).catch(() => undefined);
        for (const r of outcome.results) {
          const url = typeof r.url === 'string' ? r.url : '';
          if (!url || isUrlDenied(url, allowlist, denylist)) continue;
          hitCount.set(url, (hitCount.get(url) ?? 0) + 1);
          if (!meta.has(url)) meta.set(url, { title: r.title, snippet: r.snippet });
        }
      } catch {
        // a failing query doesn't sink the research — it's disclosed below
      }
    }

    // 2) Rank: URLs hit by more queries first, then keep order.
    const ranked = [...hitCount.entries()].sort((x, y) => y[1] - x[1]).map(([url]) => url);
    const wanted = ranked.slice(0, Math.min(a.maxPages ?? 8, MAX_PAGES));

    // 3) Fetch pages, bounded by the deadline.
    const deadline = Date.now() + FETCH_DEADLINE_MS;
    const sources: Array<{ url: string; title?: string; status: number; excerpt: string; matchedQueries: number }> = [];
    const failed: Array<{ url: string; error: string }> = [];
    for (const url of wanted) {
      if (Date.now() >= deadline) {
        failed.push({ url, error: 'tiempo agotado (deadline de la investigación)' });
        continue;
      }
      try {
        const page = await fetchWebPage(url, {
          userId: actor.id,
          conversationId: ctx.conversationId,
          timeoutMs: Math.min(15_000, Math.max(3_000, deadline - Date.now())),
        });
        sources.push({
          url: page.finalUrl,
          title: page.title || meta.get(url)?.title,
          status: page.status,
          excerpt: page.markdown.slice(0, EXCERPT_CHARS),
          matchedQueries: hitCount.get(url) ?? 1,
        });
      } catch (err) {
        failed.push({ url, error: err instanceof Error ? err.message.slice(0, 140) : 'error al leer' });
      }
    }

    return {
      goal: a.goal,
      queriesRun: a.queries.slice(0, MAX_QUERIES),
      candidatesFound: ranked.length,
      pagesRead: sources.length,
      sources,
      ...(failed.length ? { failed } : {}),
      notRead: ranked.slice(wanted.length).slice(0, 30),
      note:
        `Corpus real: solo puedes citar las URLs de "sources" (páginas leídas). ` +
        `"candidatesFound" son resultados de búsqueda sin leer — no los presentes como analizados. ` +
        `Si necesitas más de ${MAX_PAGES} fuentes, haz otra llamada con otras queries o propone una misión por lotes.`,
    };
  },
});
