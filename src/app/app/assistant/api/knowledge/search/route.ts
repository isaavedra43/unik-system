import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { searchKnowledge } from '@/modules/copilot/knowledge-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?q=&visibility= — search the approved library (any assistant user). */
export async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const q = request.nextUrl.searchParams.get('q') ?? '';
  const visibility = request.nextUrl.searchParams.get('visibility');
  if (q.trim().length < 2) return NextResponse.json({ hits: [] });
  const hits = await searchKnowledge(q, {
    visibility: visibility === 'publishable' ? 'publishable' : undefined,
  });
  return NextResponse.json({ hits });
}
