import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { listArtifacts, sanitizeArtifact } from '@/modules/ai/ai-artifacts-service';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/assistant/api/artifacts?conversationId=xxx
 *
 * Lists artifacts for a conversation. Only the conversation owner
 * (or super admin) can see them.
 */
export async function GET(req: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!hasPermission(session.user, 'assistant.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const url = new URL(req.url);
  const conversationId = url.searchParams.get('conversationId');
  if (!conversationId) {
    return NextResponse.json({ error: 'conversationId requerido' }, { status: 400 });
  }

  // Verify ownership
  const conversation = await prisma.aiConversation.findUnique({
    where: { id: conversationId },
    select: { userId: true },
  });
  if (!conversation || (conversation.userId !== session.user.id && !session.user.isSuperAdmin)) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const artifacts = await listArtifacts(conversationId);
  return NextResponse.json({
    artifacts: artifacts.map(sanitizeArtifact),
  });
}
