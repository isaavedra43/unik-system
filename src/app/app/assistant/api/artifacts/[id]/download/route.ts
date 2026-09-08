import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getArtifact } from '@/modules/ai/ai-artifacts-service';
import { prisma } from '@/lib/prisma';
import fs from 'fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/assistant/api/artifacts/[id]/download
 *
 * Downloads a binary artifact (PDF, XLSX, CSV).
 * Inline artifacts (tables, charts) return 400 — they're rendered in the chat.
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

  // Verify the artifact belongs to a conversation owned by the user
  const conversation = await prisma.aiConversation.findUnique({
    where: { id: artifact.conversationId },
    select: { userId: true },
  });
  if (!conversation || (conversation.userId !== session.user.id && !session.user.isSuperAdmin)) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  // Inline artifacts (tables, charts) can't be downloaded
  if (!artifact.storagePath) {
    return NextResponse.json({ error: 'Este artefacto no es descargable' }, { status: 400 });
  }

  if (!fs.existsSync(artifact.storagePath)) {
    return NextResponse.json({ error: 'Archivo no encontrado' }, { status: 404 });
  }

  const meta = (artifact.meta as Record<string, unknown>) ?? {};
  const mimeType = (meta.mimeType as string) ?? 'application/octet-stream';
  const filename = (meta.filename as string) ?? `artifact-${id}`;

  const fileBuffer = fs.readFileSync(artifact.storagePath);
  const headers = new Headers();
  headers.set('Content-Type', mimeType);
  headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  headers.set('Content-Length', String(fileBuffer.length));

  return new NextResponse(fileBuffer, { status: 200, headers });
}
