import { safeFetch, EgressError, isHostAllowed } from '@/modules/extensions/safe-fetch';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';
import { isInjectionAttempt } from '@/modules/ai/ai-guardrails';
import { extractReadable } from './extract';

/**
 * Public-web fetch service — the ONLY way assistant/agent tools read the open
 * internet. Builds an EgressPolicy from admin settings on every call:
 *
 *   - HTTPS only, redirects re-validated, credentials never cross origins
 *   - DNS must resolve to public IPs (SSRF protection, from safe-fetch)
 *   - admin denylist always applies; a non-empty allowlist makes it exclusive
 *   - HTML pages are extracted to markdown; everything else fails closed
 *
 * The result still counts as untrusted content — the orchestrator wraps it in
 * <untrusted> tags before the model sees it.
 */

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  markdown: string;
  extracted: boolean;
  fetchedAt: string;
  /** True when a layer flagged possible prompt injection in the content. */
  flaggedInjection: boolean;
  /** Same-origin https links (bounded) — used by web_crawl. */
  links: string[];
}

export class FetchNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchNotAllowedError';
  }
}

async function webPolicy(timeoutMs = 20_000) {
  const settings = await getAiSettings();
  const allowlist = (settings.webDomainAllowlist ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  const denylist = (settings.webDomainDenylist ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  return {
    policy: {
      // Allowlist mode restricts every hop (redirects included) inside safe-fetch;
      // empty allowlist = open web (still HTTPS + public-DNS + denylist).
      allowAnyHost: allowlist.length === 0,
      allowedHosts: allowlist,
      denyHosts: denylist,
      maxResponseBytes: Math.max(50_000, settings.webFetchMaxBytes || 2_000_000),
      timeoutMs,
      allowedContentTypes: ['text/html', 'text/plain', 'application/xhtml', 'application/json', 'text/markdown', 'text/csv'],
      maxRedirects: 4,
    },
    allowlist,
  };
}

/** Hard blocks that always apply, on top of the admin lists. */
const ALWAYS_DENIED = ['*.local', 'localhost', 'metadata.google.internal'];

export function isUrlDenied(url: string, allowlist: string[], denylist: string[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'URL inválida';
  }
  if (parsed.protocol !== 'https:') return 'Solo se permiten URLs https://';
  const host = parsed.hostname.toLowerCase();
  if (isHostAllowed(host, ALWAYS_DENIED)) return 'Host interno no permitido';
  if (isHostAllowed(host, denylist)) return `Dominio bloqueado por el administrador: ${host}`;
  if (allowlist.length > 0 && !isHostAllowed(host, allowlist)) {
    return `Dominio fuera de la lista permitida: ${host}`;
  }
  return null;
}

export async function fetchWebPage(
  url: string,
  opts: { userId?: string; conversationId?: string; timeoutMs?: number } = {}
): Promise<FetchedPage> {
  const { policy, allowlist } = await webPolicy(opts.timeoutMs);
  const denied = isUrlDenied(url, allowlist, policy.denyHosts ?? []);
  if (denied) throw new FetchNotAllowedError(denied);

  let res;
  try {
    res = await safeFetch(url, { method: 'GET', headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' } }, policy);
  } catch (err) {
    if (err instanceof EgressError) throw new FetchNotAllowedError(err.message);
    throw err;
  }

  if (res.status >= 400) {
    throw new FetchNotAllowedError(`La página respondió ${res.status}`);
  }

  const contentType = (res.headers['content-type'] ?? '').toLowerCase();
  const raw = res.body.toString('utf8');

  // Plain text / json / csv / markdown travel as-is; HTML goes through extraction.
  let title = '';
  let markdown = raw;
  let extracted = false;
  let links: string[] = [];
  if (contentType.includes('html')) {
    const page = extractReadable(raw, res.url);
    title = page.title;
    markdown = page.markdown;
    extracted = page.extracted;
    links = page.links;
  } else {
    markdown = raw.slice(0, 40_000);
  }

  const flaggedInjection = await isInjectionAttempt(markdown.slice(0, 6_000), res.url, opts);

  return {
    url,
    finalUrl: res.url,
    status: res.status,
    title,
    markdown,
    extracted,
    fetchedAt: new Date().toISOString(),
    flaggedInjection,
    links,
  };
}
