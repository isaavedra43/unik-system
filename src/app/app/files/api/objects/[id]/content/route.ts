import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { resolveFileAccess } from '@/modules/storage/storage-access';
import { openObjectStream } from '@/modules/storage/storage-service';
import { parseRangeHeader } from '@/modules/storage/object-storage';
import { streamResponse } from '@/modules/storage/stream-response';
import { storageErrorResponse } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/files/api/objects/[id]/content[?download=1]
 *
 * Authenticated streaming with Range support. Nothing is loaded fully in
 * memory; audio/video can seek and resume. Used for restricted content and
 * whenever a signed URL is not available.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const { id } = await params;
  try {
    const decision = await resolveFileAccess(session.user, id);
    if (!decision || !decision.allowed)
      return NextResponse.json({ error: 'Archivo no encontrado' }, { status: 404 });
    const object = decision.object;
    if (object.status !== 'ready') {
      return NextResponse.json({ error: 'El archivo aún no está disponible' }, { status: 409 });
    }
    const totalSize = Number(object.sizeBytes);
    const range = parseRangeHeader(request.headers.get('range'), totalSize);
    if (range === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${totalSize}` },
      });
    }
    const stream = await openObjectStream(object, range ?? undefined);
    if (!stream)
      return NextResponse.json(
        { error: 'Archivo no encontrado en el almacenamiento' },
        { status: 404 }
      );
    const meta = (object.metadata as Record<string, unknown> | null) ?? {};
    const forceDownload = request.nextUrl.searchParams.get('download') === '1';
    return streamResponse(stream, {
      fileName: object.originalName,
      mimeType: object.detectedMimeType ?? object.declaredMimeType,
      disposition: forceDownload ? 'attachment' : 'inline',
      downloadOnly: Boolean(meta.downloadOnly),
      cacheControl: 'private, max-age=300',
    });
  } catch (err) {
    return storageErrorResponse(err);
  }
}
