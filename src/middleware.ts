import { NextRequest, NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';

/**
 * Edge policy layer. Two jobs:
 *
 *  1. Sliding-window rate limits on the paths attackers and accidents abuse.
 *     Public/credential paths key on client IP; authenticated paths key on
 *     IP + session so offices behind one NAT get per-user limits.
 *  2. `Cache-Control: private, no-store` on authenticated API GETs so proxies
 *     and shared caches never retain private JSON. Streaming/download routes
 *     are exempt — they set their own media cache policy.
 */

const SESSION_COOKIE = 'unik_session';
const MINUTE = 60_000;

function clientIp(request: NextRequest): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip') ?? 'unknown';
}

interface RateRule {
  /** Pathname regex. */
  match: RegExp;
  /** Methods this rule applies to (undefined = all). */
  methods?: readonly string[];
  limit: number;
  windowMs: number;
  /** Key on IP + session cookie instead of bare IP (authenticated paths). */
  perUser?: boolean;
}

const RULES: readonly RateRule[] = [
  // Credential endpoints — per-user lockout alone doesn't stop password
  // spraying across accounts. IP-keyed (no session exists yet).
  { match: /^\/login$/, methods: ['POST'], limit: 30, windowMs: 5 * MINUTE },
  { match: /^\/change-password$/, methods: ['POST'], limit: 20, windowMs: 5 * MINUTE },

  // Public surface: signed file delivery, webhooks, internal endpoints.
  // Cheap HMAC rejects forgeries, but a burst cap bounds retry storms.
  { match: /^\/api\//, methods: ['POST'], limit: 300, windowMs: MINUTE },

  // Everything below is the authenticated app — per-user keys (NAT-safe).

  // Expensive per-call endpoints (provider $$$ / storage writes).
  {
    match: /^\/app\/[^/]+\/api\/upload$/,
    methods: ['POST'],
    limit: 30,
    windowMs: MINUTE,
    perUser: true,
  },
  {
    match: /^\/app\/assistant\/api\//,
    methods: ['POST'],
    limit: 120,
    windowMs: MINUTE,
    perUser: true,
  },
  {
    match: /^\/app\/notifications\/api\/push\/test$/,
    methods: ['POST'],
    limit: 20,
    windowMs: MINUTE,
    perUser: true,
  },

  // Chat writes: messages, reactions, channels — spam/flood bound.
  {
    match: /^\/app\/chat\/api\//,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    limit: 200,
    windowMs: MINUTE,
    perUser: true,
  },

  // Remaining API writes (settings, preferences, other modules).
  {
    match: /^\/app\/[^/]+\/api\//,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    limit: 300,
    windowMs: MINUTE,
    perUser: true,
  },

  // Server Actions POST to the page path — catch every other /app write.
  { match: /^\/app\//, methods: ['POST'], limit: 600, windowMs: MINUTE, perUser: true },
];

/** Routes that stream payloads with their own cache policy — keep their headers. */
const STREAMING_PATH = /\/api\/(objects\/[^/]+\/content|attachments\/[^/]+|media|.*\/download)$/;

function tooMany(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: 'Demasiadas solicitudes. Intenta de nuevo en unos segundos.' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
  );
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const method = request.method;
  const ip = clientIp(request);

  for (const rule of RULES) {
    if (!rule.match.test(pathname)) continue;
    if (rule.methods && !rule.methods.includes(method)) continue;

    const subject = rule.perUser
      ? `${ip}|${request.cookies.get(SESSION_COOKIE)?.value.slice(0, 16) ?? 'anon'}`
      : ip;
    const result = rateLimit(`${rule.match.source}|${subject}`, rule.limit, rule.windowMs);
    if (!result.ok) return tooMany(result.retryAfterSeconds);
    break; // first matching rule wins — specific rules sit above generic ones
  }

  const response = NextResponse.next();

  // Authenticated API reads: never cacheable by proxies or shared caches.
  // Streaming routes keep their own Cache-Control (see STREAMING_PATH).
  if (
    (method === 'GET' || method === 'HEAD') &&
    /^\/app\/.+\/api\//.test(pathname) &&
    !STREAMING_PATH.test(pathname)
  ) {
    response.headers.set('Cache-Control', 'private, no-store');
  }

  return response;
}

export const config = {
  matcher: ['/login', '/change-password', '/app/:path*', '/api/:path*'],
};
