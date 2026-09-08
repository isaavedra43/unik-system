import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import {
  validateAttachment,
  saveAttachment,
  ensureAttachmentsDir,
  getAttachmentPath,
  getExtensionFromMime,
} from '@/modules/ai/ai-attachments-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /app/assistant/api/upload
 *
 * Receives multipart/form-data with:
 * - file: the uploaded file
 * - conversationId: the conversation to attach to
 *
 * Returns { id, fileName, mimeType, sizeBytes }.
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
    await ensureAttachmentsDir();
    const ext = getExtensionFromMime(mimeType);
    const attachmentId = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = getAttachmentPath(attachmentId, ext);

    // Write file to disk
    const buffer = Buffer.from(await file.arrayBuffer());
    const fs = await import('fs/promises');
    await fs.writeFile(filePath, buffer);

    // Create DB record
    const result = await saveAttachment({
      conversationId,
      fileName: file.name,
      mimeType,
      sizeBytes,
      storagePath: filePath,
      uploadedBy: session.user.id,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    console.error('[upload] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
