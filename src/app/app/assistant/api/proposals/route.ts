import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { listPendingProposals, toProposalDTO } from '@/modules/extensions/proposals-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /app/assistant/api/proposals?conversationId= — the caller's pending approvals. */
export async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const conversationId = request.nextUrl.searchParams.get('conversationId') ?? undefined;
  const rows = await listPendingProposals(session.user.id, conversationId);
  return NextResponse.json({ proposals: rows.map(toProposalDTO) });
}
