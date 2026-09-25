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
  "media-src 'self' blob:",
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

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['pdf-parse', 'pdfkit', '@modelcontextprotocol/sdk', '@composio/core'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
