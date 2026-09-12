import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { validateAttachment, saveAttachment } from '@/modules/chat/chat-attachments-service';
import { assertChannelMember } from '@/modules/chat/chat-service';
import { StorageError } from '@/modules/storage/storage-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /app/chat/api/upload  (compatibility route — whole file through the server)
 *
 * Receives multipart/form-data with:
 * - file: the uploaded file
 * - channelId: the channel to attach to (for membership verification)
 *
 * The file goes through the object storage pipeline (quarantine → validation →
 * R2/disk). NO placeholder message is created: the attachment stays pending
 * until the user sends a message that links it (ownership, channel and READY
 * state are re-checked at that moment).
 *
 * New clients use the direct-to-storage flow under /app/files/api/uploads.
 * Returns { id, fileName, mimeType, sizeBytes, storageObjectId }.
 */
export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'chat.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  const formData = await request.formData();
  const file = formData.get('file');
  const channelId = formData.get('channelId');

  if (!file || !(file instanceof File))
    return NextResponse.json({ error: 'No se envió archivo' }, { status: 400 });
  if (!channelId || typeof channelId !== 'string')
    return NextResponse.json({ error: 'Falta channelId' }, { status: 400 });

  // Verify channel membership
  try {
    await assertChannelMember(channelId, session.user.id);
  } catch {
    return NextResponse.json({ error: 'No eres miembro de este canal' }, { status: 403 });
  }

  const mimeType = file.type || 'application/octet-stream';
  const sizeBytes = file.size;

  try {
    validateAttachment(mimeType, sizeBytes);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Archivo inválido' },
      { status: 413 }
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const attachment = await saveAttachment({
      buffer,
      fileName: file.name,
      mimeType,
      sizeBytes,
      channelId,
      uploadedBy: session.user.id,
    });

    return NextResponse.json({
      id: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      storageObjectId: attachment.storageObjectId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    const status = err instanceof StorageError ? err.status : 500;
    if (status >= 500) console.error('[chat-upload] Error:', message);
    return NextResponse.json({ error: message }, { status });
  }
}
