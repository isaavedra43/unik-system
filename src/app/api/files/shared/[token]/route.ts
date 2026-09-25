import { NextRequest, NextResponse } from 'next/server';
import { verifyShareToken } from '@/modules/ai/artifact-share';
import { getArtifact } from '@/modules/ai/ai-artifacts-service';
import { getStorageObject, openLegacyFileStream, openObjectStream, StorageError } from '@/modules/storage/storage-service';
import { isLegacyPathAllowed } from '@/modules/storage/storage-keys';
import { parseRangeHeader } from '@/modules/storage/object-storage';
import { streamResponse } from '@/modules/storage/stream-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/files/shared/[token] — public, signed download of an AI artifact
 * shared by its owner (reports sent to colleagues or customers). The token
 * carries the artifact id, an expiry and an HMAC; nothing else is accepted.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const verified = verifyShareToken(token);
  if (!verified) return NextResponse.json({ error: 'Enlace inválido o expirado' }, { status: 404 });

  const artifact = await getArtifact(verified.artifactId);
  if (!artifact || (!artifact.storagePath && !artifact.storageObjectId)) {
    return NextResponse.json({ error: 'Documento no disponible' }, { status: 404 });
  }
  const meta = (artifact.meta as Record<string, unknown>) ?? {};
  const mimeType = (meta.mimeType as string) ?? 'application/octet-stream';
  const filename = (meta.filename as string) ?? `documento-${artifact.id}`;
  const inline = request.nextUrl.searchParams.get('inline') === '1';

  try {
    let stream = null;
    let storageMeta: Record<string, unknown> | null = null;
    if (artifact.storageObjectId) {
      const object = await getStorageObject(artifact.storageObjectId);
      if (!object || object.status !== 'ready') return NextResponse.json({ error: 'Documento no disponible' }, { status: 404 });
      storageMeta = object.metadata as Record<string, unknown> | null;
      const totalSize = Number(object.sizeBytes);
      const range = parseRangeHeader(request.headers.get('range'), totalSize);
      if (range === 'unsatisfiable') {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${totalSize}` } });
      }
      stream = await openObjectStream(object, range ?? undefined);
    } else if (artifact.storagePath && isLegacyPathAllowed(artifact.storagePath)) {
      stream = await openLegacyFileStream(artifact.storagePath);
    }
    if (!stream) return NextResponse.json({ error: 'Documento no disponible' }, { status: 404 });
    // SVG/HTML/macros are download-only: ?inline=1 must never override that —
    // an inline SVG in our origin would run its scripts as the viewer.
    const downloadOnly =
      Boolean(storageMeta?.downloadOnly) ||
      mimeType === 'image/svg+xml' ||
      mimeType === 'text/html';
    return streamResponse(stream, {
      fileName: filename,
      mimeType,
      disposition: inline && !downloadOnly ? 'inline' : 'attachment',
      downloadOnly,
      cacheControl: 'private, max-age=300',
    });
  } catch (err) {
    if (err instanceof StorageError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[files/shared]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'No se pudo entregar el documento' }, { status: 500 });
  }
}
