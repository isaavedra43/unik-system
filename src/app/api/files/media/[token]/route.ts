import { NextRequest, NextResponse } from 'next/server';
import { verifyMediaToken } from '@/modules/storage/media-share';
import { getStorageObject, openLegacyFileStream, openObjectStream, StorageError } from '@/modules/storage/storage-service';
import { parseRangeHeader } from '@/modules/storage/object-storage';
import { streamResponse } from '@/modules/storage/stream-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/files/media/[token] — public, signed, short-lived delivery of a
 * storage object for messaging providers (Twilio downloads WhatsApp/MMS media
 * from here when the storage driver cannot sign URLs itself). The token carries
 * the object id, an expiry and an HMAC; nothing else is accepted.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const verified = verifyMediaToken(token);
  if (!verified) return NextResponse.json({ error: 'Enlace inválido o expirado' }, { status: 404 });

  const object = await getStorageObject(verified.objectId);
  if (!object || object.status !== 'ready') return NextResponse.json({ error: 'Archivo no disponible' }, { status: 404 });
  const mimeType = object.detectedMimeType ?? object.declaredMimeType ?? 'application/octet-stream';
  const fileName = object.originalName || `archivo-${object.id}`;

  try {
    const totalSize = Number(object.sizeBytes);
    const range = parseRangeHeader(request.headers.get('range'), totalSize);
    if (range === 'unsatisfiable') {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${totalSize}` } });
    }
    let stream = await openObjectStream(object, range ?? undefined).catch(() => null);
    if (!stream) {
      const legacyPath = (object as { legacyPath?: string | null }).legacyPath;
      if (legacyPath) stream = await openLegacyFileStream(legacyPath);
    }
    if (!stream) return NextResponse.json({ error: 'Archivo no disponible' }, { status: 404 });
    return streamResponse(stream, { fileName, mimeType, disposition: 'inline', cacheControl: 'private, max-age=600' });
  } catch (err) {
    if (err instanceof StorageError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[files/media]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'No se pudo entregar el archivo' }, { status: 500 });
  }
}
