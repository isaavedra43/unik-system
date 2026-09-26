import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { absoluteUrl } from '@/lib/app-url';

/**
 * Published sites — websites the agents build (landing pages, catalogs,
 * microsites) and publish at /sites/{slug} without leaving UNIK.
 *
 * Security model: the public route serves every file with a CSP `sandbox`
 * directive (no allow-same-origin) — the page runs in an opaque origin, so its
 * scripts can never read the ERP session cookie nor call /app APIs with the
 * visitor's credentials. HTML gets a <base> so relative links work under the
 * slug. Files live in the row itself (base64), bounded per site.
 */

export const MAX_SITE_BYTES = 8 * 1024 * 1024;
export const MAX_SITE_FILE_BYTES = 3 * 1024 * 1024;
export const MAX_SITE_FILES = 200;

export interface SiteFileInput {
  path: string;
  content: string;
  /** 'utf8' (default) for text files, 'base64' for images/fonts. */
  encoding?: 'utf8' | 'base64';
}

interface StoredFile {
  type: string;
  b64: string;
}

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  pdf: 'application/pdf',
  webmanifest: 'application/manifest+json',
};

export function mimeForPath(p: string): string {
  const ext = p.includes('.') ? p.split('.').pop()!.toLowerCase() : '';
  return MIME[ext] ?? 'application/octet-stream';
}

/** Relative, normalized, no traversal. Returns null when unsafe. */
export function normalizeSitePath(raw: string): string | null {
  const p = raw
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '')
    .trim();
  if (!p || p.length > 200) return null;
  if (/[\u0000-\u001f]/.test(p)) return null;
  const parts = p.split('/');
  if (parts.some((part) => part === '..' || part === '.' || part === '')) return null;
  if (!/^[\w\-./ ()@]+$/.test(p)) return null;
  return p;
}

export function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'sitio'
  );
}

export function siteUrl(slug: string): string {
  return absoluteUrl(`/sites/${slug}`);
}

export class SiteError extends Error {}

export async function publishSite(input: {
  userId: string;
  tenantId?: string | null;
  agentId?: string | null;
  name: string;
  slug?: string;
  description?: string;
  files: SiteFileInput[];
}): Promise<{
  id: string;
  slug: string;
  url: string;
  fileCount: number;
  sizeBytes: number;
  updated: boolean;
}> {
  if (input.files.length === 0) throw new SiteError('El sitio no tiene archivos.');
  if (input.files.length > MAX_SITE_FILES) {
    throw new SiteError(`Demasiados archivos (${input.files.length}); máximo ${MAX_SITE_FILES}.`);
  }
  const stored: Record<string, StoredFile> = {};
  let total = 0;
  for (const f of input.files) {
    const p = normalizeSitePath(f.path);
    if (!p) throw new SiteError(`Ruta inválida: "${f.path}"`);
    const buf =
      f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : Buffer.from(f.content, 'utf8');
    if (buf.byteLength > MAX_SITE_FILE_BYTES) {
      throw new SiteError(
        `"${p}" pesa ${(buf.byteLength / 1048576).toFixed(1)} MB (máx 3 MB por archivo).`
      );
    }
    total += buf.byteLength;
    stored[p] = { type: mimeForPath(p), b64: buf.toString('base64') };
  }
  if (total > MAX_SITE_BYTES) {
    throw new SiteError(
      `El sitio pesa ${(total / 1048576).toFixed(1)} MB (máx 8 MB). Optimiza imágenes o usa URLs externas.`
    );
  }
  if (!stored['index.html']) throw new SiteError('Falta index.html (la página de inicio).');

  const wanted = input.slug ? slugify(input.slug) : slugify(input.name);
  const existing = await prisma.publishedSite.findUnique({ where: { slug: wanted } });
  if (existing && existing.ownerUserId !== input.userId) {
    if (input.slug) throw new SiteError(`La dirección "${wanted}" ya está en uso. Elige otra.`);
  }
  const reuse = existing && existing.ownerUserId === input.userId;
  const slug = reuse || !existing ? wanted : `${wanted}-${Math.random().toString(36).slice(2, 6)}`;

  const data = {
    name: input.name.slice(0, 120),
    description: input.description?.slice(0, 500) ?? null,
    files: stored as unknown as Prisma.InputJsonValue,
    fileCount: Object.keys(stored).length,
    sizeBytes: total,
    status: 'published',
    publishedAt: new Date(),
    agentId: input.agentId ?? null,
  };
  const row = reuse
    ? await prisma.publishedSite.update({ where: { id: existing!.id }, data })
    : await prisma.publishedSite.create({
        data: { ...data, slug, ownerUserId: input.userId, tenantId: input.tenantId ?? null },
      });
  return {
    id: row.id,
    slug: row.slug,
    url: siteUrl(row.slug),
    fileCount: row.fileCount,
    sizeBytes: row.sizeBytes,
    updated: Boolean(reuse),
  };
}

export async function listSites(userId: string) {
  const rows = await prisma.publishedSite.findMany({
    where: { ownerUserId: userId },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      status: true,
      fileCount: true,
      sizeBytes: true,
      visits: true,
      publishedAt: true,
      updatedAt: true,
    },
  });
  return rows.map((r) => ({ ...r, url: siteUrl(r.slug) }));
}

export async function setSiteStatus(
  userId: string,
  slug: string,
  status: 'published' | 'unpublished'
) {
  const res = await prisma.publishedSite.updateMany({
    where: { slug: slugify(slug), ownerUserId: userId },
    data: { status },
  });
  return res.count > 0;
}

/** Public read — only published sites. HTML gets a <base> for relative links. */
export async function readSiteFile(
  slug: string,
  rawPath: string
): Promise<{ body: Buffer; type: string } | null> {
  const site = await prisma.publishedSite.findUnique({ where: { slug } });
  if (!site || site.status !== 'published') return null;
  const files = (site.files ?? {}) as unknown as Record<string, StoredFile>;
  const cleaned = rawPath ? normalizeSitePath(rawPath) : 'index.html';
  if (cleaned === null) return null;
  const candidates = [cleaned, `${cleaned}/index.html`, `${cleaned}.html`];
  let hit: StoredFile | undefined;
  for (const c of candidates) {
    if (files[c]) {
      hit = files[c];
      break;
    }
  }
  if (!hit && files['404.html']) hit = files['404.html'];
  if (!hit) return null;

  let body = Buffer.from(hit.b64, 'base64');
  if (hit.type.startsWith('text/html')) {
    void prisma.publishedSite
      .update({ where: { id: site.id }, data: { visits: { increment: 1 } } })
      .catch(() => undefined);
    const html = body.toString('utf8');
    if (!/<base\s/i.test(html)) {
      const base = `<base href="/sites/${site.slug}/">`;
      const injected = /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, (m) => `${m}${base}`)
        : `${base}${html}`;
      body = Buffer.from(injected, 'utf8');
    }
  }
  return { body, type: hit.type };
}
