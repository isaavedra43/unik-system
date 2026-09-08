import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { listAttachments } from '@/modules/ai/ai-attachments-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/assistant/api/attachments?conversationId=xxx
 *
 * Lists all attachments for a conversation.
 * Requires `assistant.upload` permission.
 */
export async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!hasPermission(session.user, 'assistant.upload')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const conversationId = request.nextUrl.searchParams.get('conversationId');
  if (!conversationId) {
    return NextResponse.json({ error: 'Falta conversationId' }, { status: 400 });
  }

  const attachments = await listAttachments(conversationId);
  return NextResponse.json({ attachments });
}
