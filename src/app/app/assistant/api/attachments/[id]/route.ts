import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { deleteAttachment } from '@/modules/ai/ai-attachments-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /app/assistant/api/attachments/[id]?conversationId=xxx
 *
 * Deletes an attachment (DB record + file on disk).
 * Requires `assistant.upload` permission.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!hasPermission(session.user, 'assistant.upload')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const { id } = await params;
  const conversationId = request.nextUrl.searchParams.get('conversationId');
  if (!conversationId) {
    return NextResponse.json({ error: 'Falta conversationId' }, { status: 400 });
  }

  await deleteAttachment(id, conversationId);
  return NextResponse.json({ success: true });
}
