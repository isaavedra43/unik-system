import fs from 'fs/promises';
import path from 'path';
import { prisma } from '@/lib/prisma';
import { getAiSettings } from './ai-admin-config-service';

/**
 * AI Attachments Service
 *
 * Handles file uploads for the AI assistant:
 * - Validates MIME type and file size against admin config
 * - Stores files in a private directory (data/ai-attachments)
 * - Extracts text from PDFs and text files for context
 * - Converts images to base64 data URLs for OpenAI Vision
 * - Manages attachment lifecycle (create, list, delete, cleanup)
 */

const ATTACHMENTS_DIR = path.join(process.cwd(), 'data', 'ai-attachments');

async function ensureAttachmentsDir(): Promise<void> {
  await fs.mkdir(ATTACHMENTS_DIR, { recursive: true });
}

function getAttachmentPath(id: string, ext: string): string {
  return path.join(ATTACHMENTS_DIR, `${id}.${ext}`);
}

function getExtensionFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/csv': 'csv',
  };
  return map[mimeType] ?? 'bin';
}

export interface CreateAttachmentInput {
  conversationId: string;
  messageId?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  uploadedBy: string;
}

export interface AttachmentResult {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
}

/**
 * Validates a file against admin-configured limits.
 * Throws on invalid MIME type or oversized file.
 */
export async function validateAttachment(
  mimeType: string,
  sizeBytes: number
): Promise<void> {
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

/**
 * Saves an uploaded file to disk and creates a DB record.
 */
export async function saveAttachment(
  input: CreateAttachmentInput
): Promise<AttachmentResult> {
  await ensureAttachmentsDir();

  const attachment = await prisma.aiAttachment.create({
    data: {
      conversationId: input.conversationId,
      messageId: input.messageId ?? null,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      storagePath: input.storagePath,
      uploadedBy: input.uploadedBy,
    },
  });

  return {
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    storagePath: attachment.storagePath,
  };
}

/**
 * Reads an attachment file and returns its content as base64 data URL (for images)
 * or extracted text (for PDFs and text files).
 */
export async function processAttachment(
  attachment: AttachmentResult
): Promise<
  | { type: 'image'; dataUrl: string }
  | { type: 'text'; content: string }
  | { type: 'file'; content: string }
> {
  const filePath = attachment.storagePath;

  if (attachment.mimeType.startsWith('image/')) {
    // Read image and convert to base64 data URL
    const buffer = await fs.readFile(filePath);
    const base64 = buffer.toString('base64');
    const dataUrl = `data:${attachment.mimeType};base64,${base64}`;
    return { type: 'image', dataUrl };
  }

  if (attachment.mimeType === 'application/pdf') {
    // Extract text from PDF using pdf-parse
    try {
      const buffer = await fs.readFile(filePath);
      const pdfParse = (await import('pdf-parse')).default;
      const data = await pdfParse(buffer);
      const text = data.text.slice(0, 8000); // Limit to 8000 chars
      return { type: 'text', content: text };
    } catch {
      return { type: 'text', content: '[No se pudo extraer texto del PDF]' };
    }
  }

  if (
    attachment.mimeType === 'text/plain' ||
    attachment.mimeType === 'text/csv'
  ) {
    // Read text file directly
    const content = await fs.readFile(filePath, 'utf-8');
    return { type: 'text', content: content.slice(0, 8000) };
  }

  return { type: 'file', content: `[Archivo: ${attachment.fileName}]` };
}

/**
 * Lists all attachments for a conversation.
 */
export async function listAttachments(
  conversationId: string
): Promise<AttachmentResult[]> {
  const attachments = await prisma.aiAttachment.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
  });
  return attachments.map((a) => ({
    id: a.id,
    fileName: a.fileName,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    storagePath: a.storagePath,
  }));
}

/**
 * Deletes an attachment (DB record + file on disk).
 */
export async function deleteAttachment(
  id: string,
  conversationId: string
): Promise<void> {
  const attachment = await prisma.aiAttachment.findFirst({
    where: { id, conversationId },
  });
  if (!attachment) return;

  try {
    await fs.unlink(attachment.storagePath);
  } catch {
    // File might not exist, ignore
  }

  await prisma.aiAttachment.delete({ where: { id } });
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
    try {
      await fs.unlink(attachment.storagePath);
    } catch {
      // File might not exist
    }
  }

  if (expired.length > 0) {
    await prisma.aiAttachment.deleteMany({
      where: { id: { in: expired.map((a) => a.id) } },
    });
  }

  return expired.length;
}

export {
  ATTACHMENTS_DIR,
  ensureAttachmentsDir,
  getAttachmentPath,
  getExtensionFromMime,
};
