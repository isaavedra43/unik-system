import type { NextConfig } from 'next';

/**
 * Browser-facing security headers, applied to every route (pages, API JSON and
 * static assets) from next.config — no runtime middleware cost.
 */

// The browser's LiveKit SDK connects to the configured host over wss/https.
// Deriving its origin keeps connect-src tight instead of opening all wss:.
function livekitOrigins(): string[] {
  const raw = process.env.LIVEKIT_URL?.trim();
  if (!raw) return [];
  try {
    const url = new URL(raw);
    const httpsOrigin = url.origin.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    return [...new Set([url.origin, httpsOrigin])];
  } catch {
    return [];
  }
}

const isDev = process.env.NODE_ENV !== 'production';

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next ships inline bootstrap scripts; 'unsafe-eval' is dev-only (HMR/tooling).
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  // Own file/media endpoints + data/blob previews + remote images (map tiles,
  // externally linked images in docs/chat).
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // Every data call is same-origin; LiveKit voice signaling needs its host.
  // ws:/wss: stay open in dev only, for HMR.
  `connect-src 'self'${isDev ? ' ws: wss:' : ''}${livekitOrigins()
    .map((o) => ` ${o}`)
    .join('')}`,
  // Audio/video from signed storage URLs and generated media (never scripts).
  "media-src 'self' blob: https:",
  "worker-src 'self' blob:",
  // PDF/preview iframes are always same-origin or blob: — no external frame
  // is allowed to render inside the app (phishing inside our origin).
  "frame-src 'self' blob:",
  "manifest-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  // Clickjacking: the app (login included) is never framed.
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Calls need mic/camera; location features read the user's position.
  {
    key: 'Permissions-Policy',
    value:
      'camera=(self), microphone=(self), geolocation=(self), payment=(), usb=(), serial=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=(), display-capture=()',
  },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  // OAuth/popup flows (e.g. external app connects) keep working.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
  // Internal ERP — nothing here should ever be indexed by search engines.
  { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
];

/**
 * Websites published by the agents (/sites/{slug}) are public, third-party
 * content: they get their own policy instead of the app's. `sandbox` without
 * allow-same-origin gives the page an opaque origin — its scripts can never
 * read the ERP session cookie nor call /app APIs as the visitor.
 */
const siteContentSecurityPolicy = [
  'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
  "default-src 'self' https: data: blob:",
  "script-src 'self' 'unsafe-inline' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' https: data: blob:",
  "font-src 'self' https: data:",
  "connect-src 'self' https:",
  "media-src 'self' https: data: blob:",
  'frame-src https:',
  "object-src 'none'",
  "base-uri 'self'",
  // The workspace previews the site in an iframe of the app itself.
  "frame-ancestors 'self'",
].join('; ');

const siteHeaders = [
  { key: 'Content-Security-Policy', value: siteContentSecurityPolicy },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
  },
];

const nextConfig: NextConfig = {
  // Slim runtime bundle for the Docker image (Dockerfile copies
  // .next/standalone). Keeps the repo root explicit — a stray lockfile outside
  // the project would otherwise widen the trace scope.
  output: 'standalone',
  outputFileTracingRoot: process.cwd(),
  // Prisma's generated client + query engine live under node_modules/.prisma —
  // nft tracing doesn't reliably follow its dynamic requires, so include them.
  outputFileTracingIncludes: {
    '/**': ['./node_modules/.prisma/**', './node_modules/@prisma/client/**'],
  },
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['pdf-parse', 'pdfkit', '@modelcontextprotocol/sdk', '@composio/core'],
  async headers() {
    return [
      // The app: every path except the public sites.
      { source: '/((?!sites/).*)', headers: securityHeaders },
      { source: '/sites/:path*', headers: siteHeaders },
    ];
  },
};

export default nextConfig;
