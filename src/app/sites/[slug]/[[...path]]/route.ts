import { readSiteFile } from '@/modules/sites/site-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /sites/{slug}/{...path} — public websites published by UNIVERSO agents.
 *
 * Every response carries the site CSP from next.config (`sandbox` without
 * allow-same-origin): the page lives in an opaque origin and can never touch
 * the ERP session. Unknown slugs and unpublished sites are a plain 404.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; path?: string[] }> }
) {
  const { slug, path } = await params;
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return new Response('No encontrado', { status: 404 });
  const file = await readSiteFile(slug, (path ?? []).join('/'));
  if (!file) {
    return new Response('Este sitio no existe o ya no está publicado.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(new Uint8Array(file.body), {
    headers: {
      'Content-Type': file.type,
      'Cache-Control': file.type.startsWith('text/html')
        ? 'public, max-age=0, must-revalidate'
        : 'public, max-age=300',
    },
  });
}
