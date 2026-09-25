import { getAiSettings } from '@/modules/ai/ai-admin-config-service';

/**
 * Search provider interface — the assistant asks "search this", never "call
 * Tavily". Implementations are interchangeable via settings.webSearchProvider.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface WebSearchOptions {
  query: string;
  maxResults?: number;
  /** 'news' favors recent coverage where the provider supports it. */
  topic?: 'general' | 'news';
}

export interface WebSearchOutcome {
  provider: string;
  /** Short synthesized answer when the provider offers one (Tavily answer). */
  answer?: string;
  results: WebSearchResult[];
}

export interface SearchProvider {
  readonly id: string;
  search(input: WebSearchOptions): Promise<WebSearchOutcome>;
}

export class SearchNotConfiguredError extends Error {
  constructor() {
    super('Búsqueda web no configurada: falta la API key del proveedor (Admin → Asistente IA → Internet).');
    this.name = 'SearchNotConfiguredError';
  }
}

/**
 * Resolves the configured provider. Returns null (not throws) when web search
 * is disabled or unconfigured so tools can answer "no disponible" cleanly.
 */
export async function getSearchProvider(): Promise<SearchProvider | null> {
  const settings = await getAiSettings();
  if (!settings.webSearchEnabled) return null;
  const id = (settings.webSearchProvider || 'tavily').trim().toLowerCase();
  if (id !== 'tavily') return null;
  const apiKey = settings.webSearchApiKey?.trim() || process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) return null;
  const { createTavilyProvider } = await import('./tavily');
  return createTavilyProvider(apiKey);
}
