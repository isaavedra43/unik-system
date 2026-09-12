import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getArtifact } from '@/modules/ai/ai-artifacts-service';
import { prisma } from '@/lib/prisma';
import {
  getStorageObject,
  openLegacyFileStream,
  openObjectStream,
  StorageError,
} from '@/modules/storage/storage-service';
import { isLegacyPathAllowed } from '@/modules/storage/storage-keys';
import { parseRangeHeader } from '@/modules/storage/object-storage';
import { streamResponse } from '@/modules/storage/stream-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/assistant/api/artifacts/[id]/download
 *
 * Streams a binary artifact (PDF, XLSX, CSV) from the object storage (or the
 * legacy directory for rows created before the migration) without loading it
 * in memory. Inline artifacts (tables, charts) return 400 — they're rendered
 * in the chat.
 */
export async function GET(
  request: NextRequest,
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
  if (!artifact.storagePath && !artifact.storageObjectId) {
    return NextResponse.json({ error: 'Este artefacto no es descargable' }, { status: 400 });
  }

  const meta = (artifact.meta as Record<string, unknown>) ?? {};
  const mimeType = (meta.mimeType as string) ?? 'application/octet-stream';
  const filename = (meta.filename as string) ?? `artifact-${id}`;

  try {
    let stream = null;
    let totalSize = typeof meta.sizeBytes === 'number' ? meta.sizeBytes : 0;
    if (artifact.storageObjectId) {
      const object = await getStorageObject(artifact.storageObjectId);
      if (!object) return NextResponse.json({ error: 'Archivo no encontrado' }, { status: 404 });
      if (object.status !== 'ready') {
        return NextResponse.json({ error: 'El archivo aún no está disponible' }, { status: 409 });
      }
      totalSize = Number(object.sizeBytes);
      const range = parseRangeHeader(request.headers.get('range'), totalSize);
      if (range === 'unsatisfiable') {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${totalSize}` } });
      }
      stream = await openObjectStream(object, range ?? undefined);
    } else if (artifact.storagePath && isLegacyPathAllowed(artifact.storagePath)) {
      stream = await openLegacyFileStream(artifact.storagePath);
    }
    if (!stream) {
      return NextResponse.json({ error: 'Archivo no encontrado' }, { status: 404 });
    }
    return streamResponse(stream, {
      fileName: filename,
      mimeType,
      disposition: 'attachment',
      cacheControl: 'private, no-store',
    });
  } catch (err) {
    if (err instanceof StorageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[artifacts/download]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Error al descargar el artefacto' }, { status: 500 });
  }
}
