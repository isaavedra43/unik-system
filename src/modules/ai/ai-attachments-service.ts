import { prisma } from '@/lib/prisma';
import { getAiSettings } from './ai-admin-config-service';
import {
  deleteObjectIfUnreferenced,
  getStorageObject,
  readLegacyFileToBuffer,
  readObjectToBuffer,
  uploadBufferThroughPipeline,
  StorageError,
} from '@/modules/storage/storage-service';
import { isLegacyPathAllowed } from '@/modules/storage/storage-keys';

/**
 * AI Attachments Service
 *
 * Handles files the user attaches to an assistant conversation:
 * - New uploads go through the object storage pipeline (quarantine →
 *   validation → R2/disk) and are referenced by `storageObjectId`.
 * - Legacy rows (created before the migration) keep a `storagePath` inside
 *   the allowed legacy directory and are still readable.
 * - The browser only ever sends attachment IDs. Ownership (conversation +
 *   uploader), state (ready) and linkage (not yet sent) are verified here.
 */

const MAX_IN_MEMORY_BYTES = 64 * 1024 * 1024;

interface CreateAttachmentInput {
  conversationId: string;
  messageId?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storagePath?: string | null;
  storageObjectId?: string | null;
  uploadedBy: string;
}

export type AttachmentState = 'ready' | 'pending' | 'rejected' | 'legacy';

export interface AttachmentResult {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string | null;
  storageObjectId: string | null;
  status: AttachmentState;
}

/**
 * Validates a file against admin-configured limits.
 * Throws on invalid MIME type or oversized file.
 */
export async function validateAttachment(mimeType: string, sizeBytes: number): Promise<void> {
  const settings = await getAiSettings();
  const maxSizeBytes = settings.maxAttachmentSizeMb * 1024 * 1024;

  if (sizeBytes > maxSizeBytes) {
    throw new Error(
      `Archivo demasiado grande: ${(sizeBytes / 1024 / 1024).toFixed(1)}MB. Máximo: ${settings.maxAttachmentSizeMb}MB.`
    );
  }

  if (!settings.allowedMimeTypes.includes(mimeType)) {
    throw new Error(
      `Tipo de archivo no permitido: ${mimeType}. Permitidos: ${settings.allowedMimeTypes.join(', ')}`
    );
  }
}

function toResult(row: {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string | null;
  storageObjectId: string | null;
  storageObject?: { status: string } | null;
}): AttachmentResult {
  let status: AttachmentState = 'legacy';
  if (row.storageObjectId) {
    const s = row.storageObject?.status;
    status = s === 'ready' ? 'ready' : s === 'rejected' || s === 'aborted' || s === 'deleted' ? 'rejected' : 'pending';
  }
  return {
    id: row.id,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    storagePath: row.storagePath,
    storageObjectId: row.storageObjectId,
    status,
  };
}

/** Creates the DB record for an attachment already stored (object or legacy path). */
export async function saveAttachment(input: CreateAttachmentInput): Promise<AttachmentResult> {
  const attachment = await prisma.aiAttachment.create({
    data: {
      conversationId: input.conversationId,
      messageId: input.messageId ?? null,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      storagePath: input.storagePath ?? null,
      storageObjectId: input.storageObjectId ?? null,
      uploadedBy: input.uploadedBy,
    },
    include: { storageObject: { select: { status: true } } },
  });
  return toResult(attachment);
}

/**
 * Server-side whole-file upload (legacy multipart/form-data route). The file
 * goes through quarantine + validation like any browser upload.
 */
export async function uploadAttachmentBuffer(input: {
  conversationId: string;
  userId: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<AttachmentResult> {
  const settings = await getAiSettings();
  const result = await uploadBufferThroughPipeline({
    actorId: input.userId,
    fileName: input.fileName,
    declaredMimeType: input.mimeType,
    declaredSize: input.buffer.length,
    target: { type: 'ai_conversation', id: input.conversationId },
    policy: {
      purpose: 'ai_attachment',
      maxBytes: settings.maxAttachmentSizeMb * 1024 * 1024,
      allowedMimeTypes: settings.allowedMimeTypes,
    },
    buffer: input.buffer,
  });
  if (result.status !== 'ready') {
    throw new StorageError(result.rejectionReason ?? 'Archivo rechazado', 'invalid', 415);
  }
  return saveAttachment({
    conversationId: input.conversationId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.buffer.length,
    storageObjectId: result.objectId,
    uploadedBy: input.userId,
  });
}

/**
 * Resolves the attachments a user wants to send with a message. Only returns
 * rows that belong to the conversation, were uploaded by the user, are not
 * linked to another message yet and whose object is READY (or legacy).
 * Unknown ids, other users' files and quarantined objects are ignored.
 */
export async function resolveAttachmentsForMessage(
  conversationId: string,
  userId: string,
  attachmentIds: string[]
): Promise<AttachmentResult[]> {
  const ids = [...new Set(attachmentIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return [];
  const rows = await prisma.aiAttachment.findMany({
    where: { id: { in: ids }, conversationId, uploadedBy: userId, messageId: null },
    include: { storageObject: { select: { status: true } } },
  });
  return rows.map(toResult).filter((r) => r.status === 'ready' || r.status === 'legacy');
}

async function readAttachmentBytes(attachment: AttachmentResult, maxBytes: number): Promise<Buffer> {
  if (attachment.storageObjectId) {
    const object = await getStorageObject(attachment.storageObjectId);
    if (!object) throw new Error('Archivo no encontrado');
    return readObjectToBuffer(object, maxBytes);
  }
  if (attachment.storagePath) {
    if (!isLegacyPathAllowed(attachment.storagePath)) throw new Error('Ruta heredada no permitida');
    return readLegacyFileToBuffer(attachment.storagePath, maxBytes);
  }
  throw new Error('El adjunto no tiene contenido almacenado');
}

/**
 * Reads an attachment and returns its content as base64 data URL (for images)
 * or extracted text (for PDFs and text files). Reads are bounded in size.
 */
export async function processAttachment(
  attachment: AttachmentResult
): Promise<
  | { type: 'image'; dataUrl: string }
  | { type: 'text'; content: string }
  | { type: 'file'; content: string }
> {
  const settings = await getAiSettings();
  const maxBytes = Math.min(MAX_IN_MEMORY_BYTES, Math.max(1, settings.maxAttachmentSizeMb) * 1024 * 1024);

  if (attachment.mimeType.startsWith('image/')) {
    const buffer = await readAttachmentBytes(attachment, maxBytes);
    const base64 = buffer.toString('base64');
    const dataUrl = `data:${attachment.mimeType};base64,${base64}`;
    return { type: 'image', dataUrl };
  }

  if (attachment.mimeType === 'application/pdf') {
    // Extract text from PDF using pdf-parse first, then unpdf as fallback
    // NOTE: We import the lib directly to avoid the debug mode bug in pdf-parse's index.js
    // where `!module.parent` triggers a test file read that doesn't exist
    try {
      const buffer = await readAttachmentBytes(attachment, maxBytes);

      let text = '';
      try {
        const pdfParseModule = await import('pdf-parse/lib/pdf-parse.js');
        const pdfParse = pdfParseModule.default || pdfParseModule;
        const data = await pdfParse(buffer);
        text = data.text?.trim() ?? '';
      } catch (pdfParseErr) {
        console.error(
          '[attachments] pdf-parse failed, trying unpdf:',
          pdfParseErr instanceof Error ? pdfParseErr.message : 'unknown'
        );
      }

      if (text.length === 0) {
        try {
          const { extractText, getDocumentProxy } = await import('unpdf');
          const pdf = await getDocumentProxy(new Uint8Array(buffer));
          const result = await extractText(pdf, { mergePages: true });
          text = (result.text ?? '').trim();
        } catch (unpdfErr) {
          console.error(
            '[attachments] unpdf also failed:',
            unpdfErr instanceof Error ? unpdfErr.message : 'unknown'
          );
        }
      }

      if (text.length === 0) {
        return {
          type: 'text',
          content:
            '[El PDF no contiene texto extraíble. Posiblemente es un PDF escaneado (imágenes). Sube una imagen en su lugar para que pueda analizarla con visión.]',
        };
      }
      return { type: 'text', content: text.slice(0, 8000) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      console.error('[attachments] PDF parse error:', msg);
      return {
        type: 'text',
        content: `[Error al leer el PDF: ${msg}. Si es un PDF escaneado, sube una imagen en su lugar.]`,
      };
    }
  }

  if (attachment.mimeType === 'text/plain' || attachment.mimeType === 'text/csv') {
    const buffer = await readAttachmentBytes(attachment, Math.min(maxBytes, 4 * 1024 * 1024));
    return { type: 'text', content: buffer.toString('utf-8').slice(0, 8000) };
  }

  return { type: 'file', content: `[Archivo: ${attachment.fileName}]` };
}

/**
 * Lists all attachments for a conversation.
 */
export async function listAttachments(conversationId: string): Promise<AttachmentResult[]> {
  const attachments = await prisma.aiAttachment.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    include: { storageObject: { select: { status: true } } },
  });
  return attachments.map(toResult);
}

async function removeLegacyFile(storagePath: string | null): Promise<void> {
  if (!storagePath || !isLegacyPathAllowed(storagePath)) return;
  const fs = await import('fs/promises');
  try {
    await fs.unlink(storagePath);
  } catch {
    // File might not exist, ignore
  }
}

/**
 * Deletes an attachment (DB record + object when nothing else references it).
 * Only the uploader or the conversation owner may delete it.
 */
export async function deleteAttachment(id: string, conversationId: string, userId: string): Promise<void> {
  const attachment = await prisma.aiAttachment.findFirst({
    where: { id, conversationId },
  });
  if (!attachment) return;
  const conv = await prisma.aiConversation.findUnique({
    where: { id: conversationId },
    select: { userId: true },
  });
  if (!conv || (attachment.uploadedBy !== userId && conv.userId !== userId)) return;

  await prisma.aiAttachment.delete({ where: { id } });
  if (attachment.storageObjectId) {
    await deleteObjectIfUnreferenced(attachment.storageObjectId);
  } else {
    await removeLegacyFile(attachment.storagePath);
  }
}

/**
 * Cleans up expired attachments (older than TTL hours).
 */
export async function cleanupExpiredAttachments(ttlHours: number): Promise<number> {
  const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000);
  const expired = await prisma.aiAttachment.findMany({
    where: { createdAt: { lt: cutoff } },
  });

  for (const attachment of expired) {
    await prisma.aiAttachment.delete({ where: { id: attachment.id } }).catch(() => undefined);
    if (attachment.storageObjectId) {
      await deleteObjectIfUnreferenced(attachment.storageObjectId);
    } else {
      await removeLegacyFile(attachment.storagePath);
    }
  }

  return expired.length;
}
