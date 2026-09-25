import { safeFetch } from '@/modules/extensions/safe-fetch';
import type { SearchProvider, WebSearchOptions, WebSearchOutcome, WebSearchResult } from './search-provider';

/**
 * Tavily search — API designed for agents: returns clean snippets plus an
 * optional synthesized answer. Key travels in the JSON body, never in the
 * URL or logs. Egress restricted to api.tavily.com via safe-fetch.
 * Docs: https://docs.tavily.com
 */

const TAVILY_POLICY = {
  allowedHosts: ['api.tavily.com'],
  timeoutMs: 15_000,
  maxResponseBytes: 512 * 1024,
  allowedContentTypes: ['application/json'],
  maxRedirects: 0,
};

interface TavilyRawResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

export function createTavilyProvider(apiKey: string): SearchProvider {
  return {
    id: 'tavily',

    async search(input: WebSearchOptions): Promise<WebSearchOutcome> {
      const maxResults = Math.max(1, Math.min(input.maxResults ?? 5, 10));
      const res = await safeFetch(
        'https://api.tavily.com/search',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            query: input.query.slice(0, 400),
            max_results: maxResults,
            topic: input.topic === 'news' ? 'news' : 'general',
            include_answer: 'basic',
            search_depth: 'basic',
          }),
        },
        TAVILY_POLICY
      );

      if (res.status === 401 || res.status === 403) {
        throw new Error('Tavily rechazó la API key — revísala en Admin → Asistente IA → Internet.');
      }
      if (res.status === 429) {
        throw new Error('Límite de búsquedas de Tavily alcanzado; intenta en unos minutos.');
      }
      if (res.status >= 400) {
        throw new Error(`Tavily respondió ${res.status}`);
      }

      const parsed = JSON.parse(res.body.toString('utf8')) as {
        answer?: string;
        results?: TavilyRawResult[];
      };
      const results: WebSearchResult[] = (parsed.results ?? [])
        .filter((r): r is TavilyRawResult & { url: string } => typeof r?.url === 'string' && r.url.length > 0)
        .slice(0, maxResults)
        .map((r) => ({
          title: (r.title ?? r.url).slice(0, 200),
          url: r.url,
          snippet: (r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
          ...(r.published_date ? { publishedAt: r.published_date } : {}),
        }));

      return {
        provider: 'tavily',
        ...(parsed.answer ? { answer: String(parsed.answer).slice(0, 1000) } : {}),
        results,
      };
    },
  };
}
