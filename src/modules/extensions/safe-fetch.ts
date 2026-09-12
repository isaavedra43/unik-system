import dns from 'dns/promises';
import net from 'net';

/**
 * Common egress layer for EVERY custom/external HTTP access (APIs, MCP
 * servers, OAuth exchanges, webhooks to third parties).
 *
 * Checks, in order:
 *  1. HTTPS only (plain HTTP allowed exclusively for loopback in development
 *     when `allowInsecureLocalhost` is set by tests).
 *  2. Host and port approved for the extension.
 *  3. DNS resolution: every resolved address must be public (no loopback,
 *     private, link-local, CGNAT, multicast or cloud metadata ranges).
 *  4. Redirects are followed manually (max 3) and re-checked with the same
 *     rules; credentials are never forwarded to a different origin.
 *  5. Response size and content type limits, wall-clock timeout.
 *
 * Internal UNIK services are NOT reachable through this layer: they use the
 * trusted adapters of their own modules.
 */

export interface EgressPolicy {
  /** Approved hosts (exact) or wildcard subdomains ("*.example.com"). */
  allowedHosts: string[];
  /** Approved ports. Default: [443]. */
  allowedPorts?: number[];
  maxResponseBytes?: number;
  timeoutMs?: number;
  /** Allowed response content types (prefix match). Default: json + text. */
  allowedContentTypes?: string[];
  maxRedirects?: number;
  /** Test/dev only: allow http://localhost. */
  allowInsecureLocalhost?: boolean;
  /** DNS resolver override (tests). Must return every address the name resolves to. */
  lookup?: (hostname: string) => Promise<string[]>;
}

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | null;
  signal?: AbortSignal;
}

export interface SafeFetchResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  url: string;
  durationMs: number;
}

export class EgressError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'scheme'
      | 'host'
      | 'port'
      | 'dns'
      | 'private_address'
      | 'redirect'
      | 'timeout'
      | 'too_large'
      | 'content_type'
      | 'network'
  ) {
    super(message);
    this.name = 'EgressError';
  }
}

const DEFAULT_CONTENT_TYPES = [
  'application/json',
  'text/',
  'application/xml',
  'application/problem+json',
];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inCidr4(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '255.255.255.255/32',
];

/** True when the address is loopback, private, link-local, metadata or otherwise not public. */
export function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    return !BLOCKED_V4.some((cidr) => inCidr4(address, cidr));
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return false;
    if (
      lower.startsWith('fe80:') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    )
      return false;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return false;
    if (lower.startsWith('ff')) return false;
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.slice(7);
      return net.isIPv4(v4) ? isPublicAddress(v4) : false;
    }
    if (lower.startsWith('64:ff9b:')) return false;
    if (lower.startsWith('2001:db8:')) return false;
    return true;
  }
  return false;
}

export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const suffix = p.slice(1);
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p;
}

export function isHostAllowed(host: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((p) => hostMatches(host, p));
}

async function assertUrlAllowed(url: URL, policy: EgressPolicy): Promise<void> {
  const insecureLocal =
    policy.allowInsecureLocalhost &&
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !insecureLocal) {
    throw new EgressError('Solo se permite HTTPS', 'scheme');
  }
  if (!isHostAllowed(url.hostname, policy.allowedHosts)) {
    throw new EgressError(`Dominio no aprobado: ${url.hostname}`, 'host');
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const allowedPorts = policy.allowedPorts ?? [443];
  if (!allowedPorts.includes(port) && !insecureLocal) {
    throw new EgressError(`Puerto no aprobado: ${port}`, 'port');
  }
  if (insecureLocal) return;

  let addresses: string[];
  if (net.isIP(url.hostname)) {
    addresses = [url.hostname];
  } else {
    try {
      addresses = policy.lookup
        ? await policy.lookup(url.hostname)
        : (await dns.lookup(url.hostname, { all: true, verbatim: true })).map((r) => r.address);
    } catch {
      throw new EgressError(`No se pudo resolver ${url.hostname}`, 'dns');
    }
  }
  if (addresses.length === 0) throw new EgressError(`Sin direcciones para ${url.hostname}`, 'dns');
  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      throw new EgressError(
        `Destino no permitido (dirección interna): ${url.hostname}`,
        'private_address'
      );
    }
  }
}

async function readBounded(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new EgressError('Respuesta demasiado grande', 'too_large');
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new EgressError('Respuesta demasiado grande', 'too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Performs an outbound request under the policy. Never follows redirects
 * automatically; each hop is re-validated and cross-origin hops drop the
 * Authorization header.
 */
export async function safeFetch(
  input: string,
  init: SafeFetchInit,
  policy: EgressPolicy,
  fetchImpl: typeof fetch = fetch
): Promise<SafeFetchResult> {
  const timeoutMs = policy.timeoutMs ?? 15_000;
  const maxBytes = policy.maxResponseBytes ?? 2 * 1024 * 1024;
  const maxRedirects = policy.maxRedirects ?? 3;
  const allowedTypes = policy.allowedContentTypes ?? DEFAULT_CONTENT_TYPES;
  const startedAt = Date.now();

  let url = new URL(input);
  let headers = { ...(init.headers ?? {}) };
  let method = init.method ?? 'GET';
  let body = init.body ?? null;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertUrlAllowed(url, policy);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, timeoutMs - (Date.now() - startedAt))
    );
    const onAbort = () => controller.abort();
    init.signal?.addEventListener('abort', onAbort, { once: true });
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method,
        headers,
        body: body === null ? undefined : typeof body === 'string' ? body : new Uint8Array(body),
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new EgressError('Tiempo de espera agotado', 'timeout');
      throw new EgressError(err instanceof Error ? err.message : 'Error de red', 'network');
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', onAbort);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new EgressError('Redirección sin destino', 'redirect');
      if (hop === maxRedirects) throw new EgressError('Demasiadas redirecciones', 'redirect');
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        // Never leak credentials across origins.
        const { Authorization: _a, authorization: _b, Cookie: _c, cookie: _d, ...rest } = headers;
        void _a;
        void _b;
        void _c;
        void _d;
        headers = rest;
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = null;
      }
      url = next;
      continue;
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (contentType && !allowedTypes.some((t) => contentType.startsWith(t))) {
      throw new EgressError(`Tipo de respuesta no permitido: ${contentType}`, 'content_type');
    }
    const buffer = await readBounded(res, maxBytes);
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      outHeaders[k] = v;
    });
    return {
      status: res.status,
      headers: outHeaders,
      body: buffer,
      url: url.toString(),
      durationMs: Date.now() - startedAt,
    };
  }
  throw new EgressError('Demasiadas redirecciones', 'redirect');
}
