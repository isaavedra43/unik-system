import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getArtifact, sanitizeArtifact } from '@/modules/ai/ai-artifacts-service';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/assistant/api/artifacts/[id]
 *
 * Returns artifact metadata and inline data (for tables and charts).
 * Does NOT return file content — use /download for that.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!hasPermission(session.user, 'assistant.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const { id } = await params;
  const artifact = await getArtifact(id);
  if (!artifact) {
    return NextResponse.json({ error: 'Artefacto no encontrado' }, { status: 404 });
  }

  // Verify ownership
  const conversation = await prisma.aiConversation.findUnique({
    where: { id: artifact.conversationId },
    select: { userId: true },
  });
  if (!conversation || (conversation.userId !== session.user.id && !session.user.isSuperAdmin)) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  return NextResponse.json({ artifact: sanitizeArtifact(artifact) });
}
