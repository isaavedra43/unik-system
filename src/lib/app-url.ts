/**
 * Canonical public base URL of this deployment (no trailing slash).
 * Comes from APP_URL (Railway) — never guessed from a hostname so links the AI
 * shares (reports, quotes, maps) always point to the real domain.
 */
export function getAppBaseUrl(): string {
  const raw = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || '').trim();
  return raw.replace(/\/+$/, '');
}

/** Absolute URL for an app path when APP_URL is configured; the path otherwise. */
export function absoluteUrl(path: string): string {
  const base = getAppBaseUrl();
  if (!base) return path;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
