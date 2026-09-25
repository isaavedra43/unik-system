import { safeFetch } from '@/modules/extensions/safe-fetch';
import type { SearchProvider, WebSearchOptions, WebSearchOutcome, WebSearchResult } from './search-provider';

/**
 * OpenRouter web search — Perplexity Sonar serves real-time web results with
 * citations through the OpenRouter key the install already has. Fallback when
 * Tavily isn't configured so "buscar en internet" works out of the box.
 * Egress restricted to openrouter.ai via safe-fetch.
 */

const OPENROUTER_POLICY = {
  allowedHosts: ['openrouter.ai'],
  timeoutMs: 25_000,
  maxResponseBytes: 512 * 1024,
  allowedContentTypes: ['application/json'],
  maxRedirects: 0,
};

const SONAR_MODEL = 'perplexity/sonar';

interface SonarResponse {
  choices?: { message?: { content?: string } }[];
  citations?: string[];
}

export function createOpenRouterSearchProvider(apiKey: string): SearchProvider {
  return {
    id: 'openrouter-sonar',

    async search(input: WebSearchOptions): Promise<WebSearchOutcome> {
      const res = await safeFetch(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: SONAR_MODEL,
            messages: [
              {
                role: 'user',
                content:
                  `${input.query.slice(0, 400)}\n\n` +
                  `Responde en español, directo al punto. ${input.topic === 'news' ? 'Prioriza cobertura reciente.' : ''}`,
              },
            ],
          }),
        },
        OPENROUTER_POLICY
      );

      if (res.status === 401 || res.status === 403) {
        throw new Error('OpenRouter rechazó la API key para búsqueda web — revísala en Admin → Asistente IA.');
      }
      if (res.status === 429) {
        throw new Error('Límite de búsquedas alcanzado; intenta en unos minutos.');
      }
      if (res.status >= 400) {
        throw new Error(`Búsqueda web respondió ${res.status}`);
      }

      const parsed = JSON.parse(res.body.toString('utf8')) as SonarResponse;
      const answer = parsed.choices?.[0]?.message?.content?.trim() ?? '';
      const citations = Array.isArray(parsed.citations) ? parsed.citations : [];

      // Sonar returns sources as citation URLs — title from the domain.
      const results: WebSearchResult[] = citations.slice(0, input.maxResults ?? 5).map((url) => {
        let host = url;
        try {
          host = new URL(url).hostname.replace(/^www\./, '');
        } catch { /* keep raw */ }
        return { title: host.slice(0, 200), url, snippet: '' };
      });

      return {
        provider: 'openrouter-sonar',
        ...(answer ? { answer: answer.slice(0, 2000) } : {}),
        results,
      };
    },
  };
}
