import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { openChatAttachmentForUser } from '@/modules/chat/chat-attachments-service';
import { streamResponse } from '@/modules/storage/stream-response';
import { parseRangeHeader } from '@/modules/storage/object-storage';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/chat/api/attachments/[id]
 *
 * Streams an attachment to the client without loading it in memory.
 * Requires authentication and current channel membership (or being the
 * uploader of a still-pending file). Supports Range for audio/video seeking.
 * SVG/HTML and macro-enabled files are delivered as downloads only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'chat.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  const { id } = await params;
  const row = await prisma.internalChatAttachment.findUnique({
    where: { id },
    select: { sizeBytes: true },
  });
  if (!row) return NextResponse.json({ error: 'Archivo no encontrado' }, { status: 404 });

  const range = parseRangeHeader(request.headers.get('range'), row.sizeBytes);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${row.sizeBytes}` } });
  }

  const result = await openChatAttachmentForUser(id, session.user.id, range ?? undefined);
  if (!result) return NextResponse.json({ error: 'Archivo no encontrado' }, { status: 404 });

  const forceDownload = request.nextUrl.searchParams.get('download') === '1';
  return streamResponse(result.stream, {
    fileName: result.fileName,
    mimeType: result.mimeType,
    disposition: result.downloadOnly || forceDownload ? 'attachment' : 'inline',
    downloadOnly: result.downloadOnly,
    cacheControl: 'private, max-age=3600',
  });
}
