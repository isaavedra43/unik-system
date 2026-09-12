import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { validateAttachment, uploadAttachmentBuffer } from '@/modules/ai/ai-attachments-service';
import { prisma } from '@/lib/prisma';
import { StorageError } from '@/modules/storage/storage-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /app/assistant/api/upload  (compatibility route — whole file through the server)
 *
 * Receives multipart/form-data with:
 * - file: the uploaded file
 * - conversationId: the conversation to attach to (must belong to the user)
 *
 * The file goes through the object storage pipeline (quarantine → validation
 * → R2/disk). Returns { id, fileName, mimeType, sizeBytes } — never a path.
 * New clients use the direct-to-storage flow under /app/files/api/uploads.
 *
 * Requires `assistant.upload` permission.
 */
export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!hasPermission(session.user, 'assistant.upload')) {
    return NextResponse.json({ error: 'Sin permiso de upload' }, { status: 403 });
  }

  const formData = await request.formData();
  const file = formData.get('file');
  const conversationId = formData.get('conversationId');

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'No se envió archivo' }, { status: 400 });
  }
  if (!conversationId || typeof conversationId !== 'string') {
    return NextResponse.json({ error: 'Falta conversationId' }, { status: 400 });
  }

  // The conversation must belong to the uploader.
  const conversation = await prisma.aiConversation.findFirst({
    where: { id: conversationId, userId: session.user.id },
    select: { id: true },
  });
  if (!conversation) {
    return NextResponse.json({ error: 'Conversación no encontrada' }, { status: 404 });
  }

  const mimeType = file.type || 'application/octet-stream';
  const sizeBytes = file.size;

  // Validate against admin config
  try {
    await validateAttachment(mimeType, sizeBytes);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Archivo inválido' },
      { status: 413 }
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await uploadAttachmentBuffer({
      conversationId,
      userId: session.user.id,
      fileName: file.name,
      mimeType,
      buffer,
    });

    return NextResponse.json({
      id: result.id,
      fileName: result.fileName,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      status: result.status,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    const status = err instanceof StorageError ? err.status : 500;
    if (status >= 500) console.error('[upload] Error:', message);
    return NextResponse.json({ error: message }, { status });
  }
}
