import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { validateAttachment } from '@/modules/chat/chat-attachments-service';
import { chatStorage, getExtensionFromMime } from '@/modules/chat/chat-storage';
import { assertChannelMember } from '@/modules/chat/chat-service';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /app/chat/api/upload
 *
 * Receives multipart/form-data with:
 * - file: the uploaded file
 * - channelId: the channel to attach to (for membership verification)
 *
 * Creates a ChatAttachment record linked to a placeholder message (sender-only,
 * no content). The client links this attachment to the actual message when
 * sending. Returns { id, fileName, mimeType, sizeBytes }.
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
    const ext = getExtensionFromMime(mimeType);
    const key = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const storagePath = await chatStorage.save(buffer, key, ext);

    // Create a placeholder message (sender only, no content) to link the attachment
    const message = await prisma.internalChatMessage.create({
      data: {
        channelId,
        senderId: session.user.id,
        content: null,
      },
    });

    const attachment = await prisma.internalChatAttachment.create({
      data: {
        messageId: message.id,
        fileName: file.name,
        mimeType,
        sizeBytes,
        storagePath,
      },
    });

    // Update channel lastMessageAt
    await prisma.internalChatChannel.update({
      where: { id: channelId },
      data: { lastMessageAt: message.createdAt },
    });

    return NextResponse.json({
      id: attachment.id,
      messageId: message.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    console.error('[chat-upload] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
