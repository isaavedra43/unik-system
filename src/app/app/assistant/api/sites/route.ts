import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { listSites, setSiteStatus } from '@/modules/sites/site-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /app/assistant/api/sites — the websites the caller's agents published. */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  try {
    return NextResponse.json({ sites: await listSites(session.user.id) });
  } catch {
    // Table not migrated yet: the panel shows the empty state.
    return NextResponse.json({ sites: [] });
  }
}

const bodySchema = z.object({
  slug: z.string().min(1).max(80),
  status: z.enum(['published', 'unpublished']),
});

/** POST { slug, status } — take a site offline or back online (owner only). */
export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  const ok = await setSiteStatus(session.user.id, parsed.data.slug, parsed.data.status).catch(
    () => false
  );
  if (!ok) return NextResponse.json({ error: 'Sitio no encontrado' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
