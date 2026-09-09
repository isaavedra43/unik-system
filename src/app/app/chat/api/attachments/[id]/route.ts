import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getAttachmentForUser } from '@/modules/chat/chat-attachments-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/chat/api/attachments/[id]
 *
 * Streams an attachment file to the client. Requires authentication and
 * channel membership verification. Supports Range requests for video/audio.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'chat.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  const { id } = await params;
  const result = await getAttachmentForUser(id, session.user.id);
  if (!result) return NextResponse.json({ error: 'Archivo no encontrado' }, { status: 404 });

  const { buffer, fileName, mimeType, sizeBytes } = result;

  // Check for Range header (video/audio streaming)
  const rangeHeader = request.headers.get('range');
  if (rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : sizeBytes - 1;
      const chunkSize = end - start + 1;
      const chunk = new Uint8Array(buffer.subarray(start, end + 1));

      return new Response(chunk, {
        status: 206,
        headers: {
          'Content-Type': mimeType,
          'Content-Range': `bytes ${start}-${end}/${sizeBytes}`,
          'Content-Length': chunkSize.toString(),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=3600',
          'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`,
        },
      });
    }
  }

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': mimeType,
      'Content-Length': sizeBytes.toString(),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`,
    },
  });
}
