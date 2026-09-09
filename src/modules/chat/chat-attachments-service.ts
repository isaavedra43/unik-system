import { prisma } from '@/lib/prisma';
import { chatStorage, getExtensionFromMime } from './chat-storage';

/**
 * Chat attachments service.
 *
 * Handles validation, saving, and retrieval of files attached to chat
 * messages (photos, videos, audio, documents). Files are stored via the
 * ChatStorage abstraction (disk by default, S3/R2 in the future).
 */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_DOC_BYTES = 25 * 1024 * 1024; // 25 MB

const ALLOWED_MIME_TYPES = new Set([
  // images
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // videos
  'video/mp4',
  'video/webm',
  'video/ogg',
  // audio
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/aac',
  'audio/webm',
  'audio/webm;codecs=opus',
  // documents
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/msword',
  'application/zip',
]);

export class ChatAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatAttachmentError';
  }
}

export function validateAttachment(mimeType: string, sizeBytes: number): void {
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new ChatAttachmentError(`Tipo de archivo no permitido: ${mimeType}`);
  }

  const maxBytes = getMaxSizeForMime(mimeType);
  if (sizeBytes > maxBytes) {
    const maxMB = (maxBytes / 1024 / 1024).toFixed(0);
    throw new ChatAttachmentError(`Archivo demasiado grande. Máximo: ${maxMB}MB`);
  }
}

function getMaxSizeForMime(mimeType: string): number {
  if (mimeType.startsWith('image/')) return MAX_IMAGE_BYTES;
  if (mimeType.startsWith('video/')) return MAX_VIDEO_BYTES;
  if (mimeType.startsWith('audio/')) return MAX_AUDIO_BYTES;
  return MAX_DOC_BYTES;
}

export interface SaveAttachmentInput {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  messageId: string;
}

export interface AttachmentResult {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasThumbnail: boolean;
}

export async function saveAttachment(input: SaveAttachmentInput): Promise<AttachmentResult> {
  const ext = getExtensionFromMime(input.mimeType);
  const key = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const storagePath = await chatStorage.save(input.buffer, key, ext);

  const attachment = await prisma.internalChatAttachment.create({
    data: {
      messageId: input.messageId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      storagePath,
    },
  });

  return {
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    storagePath: attachment.storagePath,
    width: attachment.width,
    height: attachment.height,
    durationMs: attachment.durationMs,
    hasThumbnail: !!attachment.thumbnailPath,
  };
}

export async function getAttachmentForUser(
  attachmentId: string,
  userId: string
): Promise<{ buffer: Buffer; fileName: string; mimeType: string; sizeBytes: number } | null> {
  const attachment = await prisma.internalChatAttachment.findUnique({
    where: { id: attachmentId },
    include: {
      message: {
        select: {
          channelId: true,
        },
      },
    },
  });

  if (!attachment) return null;

  // Verify the user is a member of the channel
  const membership = await prisma.internalChatMember.findFirst({
    where: { channelId: attachment.message.channelId, userId, leftAt: null },
  });

  if (!membership) return null;

  const buffer = await chatStorage.read(attachment.storagePath);
  return {
    buffer,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  };
}

export async function deleteAttachment(attachmentId: string): Promise<void> {
  const attachment = await prisma.internalChatAttachment.findUnique({
    where: { id: attachmentId },
  });
  if (!attachment) return;
  await chatStorage.delete(attachment.storagePath);
  await prisma.internalChatAttachment.delete({ where: { id: attachmentId } });
}
