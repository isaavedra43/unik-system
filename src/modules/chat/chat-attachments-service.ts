import { prisma } from '@/lib/prisma';
import {
  deleteObjectIfUnreferenced,
  getStorageObject,
  openLegacyFileStream,
  openObjectStream,
  uploadBufferThroughPipeline,
  StorageError,
} from '@/modules/storage/storage-service';
import type { ByteRange, ObjectStreamResult } from '@/modules/storage/object-storage';
import { isLegacyPathAllowed } from '@/modules/storage/storage-keys';

/**
 * Chat attachments service.
 *
 * Files attached to chat messages (photos, videos, audio, documents) live in
 * the object storage (R2 in production). New rows reference a
 * `StorageObject`; rows created before the migration still carry a legacy
 * `storagePath` that is readable only inside the allowed legacy directory.
 *
 * An attachment is authorized through its channel: the uploader while it is
 * pending, and every active member once it is part of a message.
 */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_DOC_BYTES = 25 * 1024 * 1024; // 25 MB

export const CHAT_ALLOWED_MIME_TYPES = new Set([
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

class ChatAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatAttachmentError';
  }
}

export function validateAttachment(mimeType: string, sizeBytes: number): void {
  if (!CHAT_ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new ChatAttachmentError(`Tipo de archivo no permitido: ${mimeType}`);
  }

  const maxBytes = getChatMaxSizeForMime(mimeType);
  if (sizeBytes > maxBytes) {
    const maxMB = (maxBytes / 1024 / 1024).toFixed(0);
    throw new ChatAttachmentError(`Archivo demasiado grande. Máximo: ${maxMB}MB`);
  }
}

export function getChatMaxSizeForMime(mimeType: string): number {
  if (mimeType.startsWith('image/')) return MAX_IMAGE_BYTES;
  if (mimeType.startsWith('video/')) return MAX_VIDEO_BYTES;
  if (mimeType.startsWith('audio/')) return MAX_AUDIO_BYTES;
  return MAX_DOC_BYTES;
}

export interface AttachmentResult {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageObjectId: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasThumbnail: boolean;
}

interface SaveAttachmentInput {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  channelId: string;
  uploadedBy: string;
  /** Link immediately to a message (server-side flows). */
  messageId?: string | null;
}

/**
 * Server-side whole-file save (legacy multipart route, voice notes). The file
 * goes through quarantine + validation like any browser upload and is stored
 * as a pending attachment (no placeholder message is created).
 */
export async function saveAttachment(input: SaveAttachmentInput): Promise<AttachmentResult> {
  validateAttachment(input.mimeType, input.sizeBytes);
  const result = await uploadBufferThroughPipeline({
    actorId: input.uploadedBy,
    fileName: input.fileName,
    declaredMimeType: input.mimeType,
    declaredSize: input.buffer.length,
    target: { type: 'chat_channel', id: input.channelId },
    policy: {
      purpose: 'chat',
      maxBytes: getChatMaxSizeForMime(input.mimeType),
      allowedMimeTypes: [...CHAT_ALLOWED_MIME_TYPES],
    },
    buffer: input.buffer,
  });
  if (result.status !== 'ready') {
    throw new ChatAttachmentError(result.rejectionReason ?? 'Archivo rechazado');
  }
  const meta = (result.object.metadata as Record<string, unknown> | null) ?? {};
  const attachment = await prisma.internalChatAttachment.create({
    data: {
      messageId: input.messageId ?? null,
      channelId: input.channelId,
      uploadedBy: input.uploadedBy,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      storagePath: null,
      storageObjectId: result.objectId,
      width: typeof meta.width === 'number' ? meta.width : null,
      height: typeof meta.height === 'number' ? meta.height : null,
    },
  });

  return {
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    storageObjectId: attachment.storageObjectId,
    width: attachment.width,
    height: attachment.height,
    durationMs: attachment.durationMs,
    hasThumbnail: !!attachment.thumbnailPath,
  };
}

export interface ChatAttachmentStream {
  stream: ObjectStreamResult;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** SVG/HTML/macros: deliver as download, never render inline. */
  downloadOnly: boolean;
}

/**
 * Opens an attachment for streaming after verifying the user's current
 * access (channel membership, or uploader for pending files). Supports Range
 * so audio/video can seek without downloading the whole file.
 */
export async function openChatAttachmentForUser(
  attachmentId: string,
  userId: string,
  range?: ByteRange
): Promise<ChatAttachmentStream | null> {
  const attachment = await prisma.internalChatAttachment.findUnique({
    where: { id: attachmentId },
    include: { message: { select: { channelId: true } } },
  });
  if (!attachment) return null;

  const channelId = attachment.message?.channelId ?? attachment.channelId;
  let allowed = false;
  if (channelId) {
    const membership = await prisma.internalChatMember.findFirst({
      where: { channelId, userId, leftAt: null },
      select: { id: true },
    });
    allowed = Boolean(membership);
  }
  if (!allowed && !attachment.message && attachment.uploadedBy === userId) allowed = true;
  if (!allowed) return null;

  let stream: ObjectStreamResult | null = null;
  let downloadOnly = false;
  try {
    if (attachment.storageObjectId) {
      const object = await getStorageObject(attachment.storageObjectId);
      if (!object || object.status !== 'ready') return null;
      const meta = (object.metadata as Record<string, unknown> | null) ?? {};
      downloadOnly = Boolean(meta.downloadOnly);
      stream = await openObjectStream(object, range);
    } else if (attachment.storagePath && isLegacyPathAllowed(attachment.storagePath)) {
      stream = await openLegacyFileStream(attachment.storagePath, range);
      downloadOnly = attachment.mimeType === 'image/svg+xml';
    }
  } catch (err) {
    if (err instanceof StorageError) return null;
    throw err;
  }
  if (!stream) return null;
  return {
    stream,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    downloadOnly,
  };
}

/**
 * Deletes an attachment row. The binary is removed only when no other
 * reference (forwarded copies, other messages) still needs it.
 */
export async function deleteAttachment(attachmentId: string): Promise<void> {
  const attachment = await prisma.internalChatAttachment.findUnique({
    where: { id: attachmentId },
  });
  if (!attachment) return;
  await prisma.internalChatAttachment.delete({ where: { id: attachmentId } });
  if (attachment.storageObjectId) {
    await deleteObjectIfUnreferenced(attachment.storageObjectId);
  } else if (attachment.storagePath && isLegacyPathAllowed(attachment.storagePath)) {
    // Legacy files may be shared by forwarded copies (same path): only unlink when
    // no other row points to the same path.
    const others = await prisma.internalChatAttachment.count({
      where: { storagePath: attachment.storagePath },
    });
    if (others === 0) {
      const fs = await import('fs/promises');
      await fs.unlink(attachment.storagePath).catch(() => undefined);
    }
  }
}

/**
 * Returns the ids of pending attachments the actor may link to a message in
 * `channelId`: uploaded by them, for that channel, not linked yet and READY
 * (or legacy). Everything else is silently dropped.
 */
export async function resolveLinkableAttachmentIds(
  channelId: string,
  userId: string,
  attachmentIds: string[]
): Promise<string[]> {
  const ids = [...new Set(attachmentIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return [];
  const rows = await prisma.internalChatAttachment.findMany({
    where: { id: { in: ids }, channelId, uploadedBy: userId, messageId: null },
    select: { id: true, storageObjectId: true, storagePath: true, storageObject: { select: { status: true } } },
  });
  return rows
    .filter((r) => (r.storageObjectId ? r.storageObject?.status === 'ready' : Boolean(r.storagePath)))
    .map((r) => r.id);
}
