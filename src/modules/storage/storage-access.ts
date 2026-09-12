import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import type { StorageObjectRecord } from './storage-repository';
import {
  getStorageObject,
  StorageError,
  type UploadPolicy,
  type UploadTarget,
} from './storage-service';

/**
 * Authorization for uploads and downloads.
 *
 * Identifiers never grant access. Every route re-resolves actor, scope and
 * resource:
 * - An upload is authorized against its DESTINATION (conversation, channel,
 *   document...). The destination also decides the size/type policy, so each
 *   module keeps its current limits.
 * - A download is authorized through the RECORDS that reference the object
 *   (attachment → conversation owner, chat attachment → channel member...).
 *
 * Modules register resolvers here instead of importing each other.
 */

export interface UploadTargetResolution {
  policy: UploadPolicy;
  /** Creates the module record that references the object; returns its id. */
  createReference?: (object: StorageObjectRecord) => Promise<{ referenceId: string }>;
}

export type UploadTargetResolver = (
  actor: CurrentUser,
  targetId: string,
  declared: { fileName: string; mimeType: string; sizeBytes: number }
) => Promise<UploadTargetResolution>;

export type FileAccessResolver = (
  actor: CurrentUser,
  object: StorageObjectRecord
) => Promise<boolean>;

const uploadTargetResolvers = new Map<string, UploadTargetResolver>();
const fileAccessResolvers = new Map<string, FileAccessResolver[]>();

export function registerUploadTargetResolver(type: string, resolver: UploadTargetResolver): void {
  uploadTargetResolvers.set(type, resolver);
}

export function registerFileAccessResolver(purpose: string, resolver: FileAccessResolver): void {
  const list = fileAccessResolvers.get(purpose) ?? [];
  list.push(resolver);
  fileAccessResolvers.set(purpose, list);
}

export function listUploadTargetTypes(): string[] {
  return [...uploadTargetResolvers.keys()];
}

export async function resolveUploadTarget(
  actor: CurrentUser,
  target: UploadTarget,
  declared: { fileName: string; mimeType: string; sizeBytes: number }
): Promise<UploadTargetResolution> {
  const resolver = uploadTargetResolvers.get(target.type);
  if (!resolver) {
    throw new StorageError('Destino de carga no soportado', 'invalid', 400);
  }
  return resolver(actor, target.id, declared);
}

export interface FileAccessDecision {
  object: StorageObjectRecord;
  allowed: boolean;
}

/**
 * Resolves whether `actor` may read `objectId` right now. Revoked membership
 * or ownership changes apply immediately because nothing is cached.
 */
export async function resolveFileAccess(
  actor: CurrentUser,
  objectId: string
): Promise<FileAccessDecision | null> {
  const object = await getStorageObject(objectId);
  if (!object || object.deletedAt || object.status === 'deleted') return null;

  const resolvers = fileAccessResolvers.get(object.purpose) ?? [];
  for (const resolver of resolvers) {
    try {
      if (await resolver(actor, object)) return { object, allowed: true };
    } catch {
      // A failing resolver never grants access.
    }
  }
  // Storage administrators may inspect any object (audit, restore, reconcile).
  if (hasPermission(actor, 'files.admin')) return { object, allowed: true };
  return { object, allowed: false };
}

// ---------------------------------------------------------------------------
// Built-in resolvers: AI assistant and internal chat
// ---------------------------------------------------------------------------

async function ownsConversation(actor: CurrentUser, conversationId: string): Promise<boolean> {
  const conv = await prisma.aiConversation.findUnique({
    where: { id: conversationId },
    select: { userId: true },
  });
  if (!conv) return false;
  return conv.userId === actor.id || actor.isSuperAdmin;
}

async function isChannelMember(actor: CurrentUser, channelId: string): Promise<boolean> {
  const membership = await prisma.internalChatMember.findFirst({
    where: { channelId, userId: actor.id, leftAt: null },
    select: { id: true },
  });
  return Boolean(membership);
}

registerUploadTargetResolver('ai_conversation', async (actor, conversationId, declared) => {
  if (!hasPermission(actor, 'assistant.upload')) {
    throw new StorageError('Sin permiso de upload', 'forbidden', 403);
  }
  const conv = await prisma.aiConversation.findFirst({
    where: { id: conversationId, userId: actor.id },
    select: { id: true },
  });
  if (!conv) throw new StorageError('Conversación no encontrada', 'not_found', 404);
  const { getAiSettings } = await import('@/modules/ai/ai-admin-config-service');
  const settings = await getAiSettings();
  return {
    policy: {
      purpose: 'ai_attachment',
      maxBytes: settings.maxAttachmentSizeMb * 1024 * 1024,
      allowedMimeTypes: settings.allowedMimeTypes,
    },
    async createReference(object) {
      const attachment = await prisma.aiAttachment.create({
        data: {
          conversationId,
          fileName: object.originalName,
          mimeType: declared.mimeType,
          sizeBytes: declared.sizeBytes,
          storagePath: null,
          storageObjectId: object.id,
          uploadedBy: actor.id,
        },
      });
      return { referenceId: attachment.id };
    },
  };
});

registerUploadTargetResolver('chat_channel', async (actor, channelId, declared) => {
  if (!hasPermission(actor, 'chat.use')) {
    throw new StorageError('Sin permiso', 'forbidden', 403);
  }
  if (!(await isChannelMember(actor, channelId))) {
    throw new StorageError('No eres miembro de este canal', 'forbidden', 403);
  }
  const { isUserSuspended } = await import('@/modules/chat/chat-admin-service');
  if (await isUserSuspended(actor.id)) {
    throw new StorageError('Tu cuenta de chat está suspendida', 'forbidden', 403);
  }
  const { CHAT_ALLOWED_MIME_TYPES, getChatMaxSizeForMime } =
    await import('@/modules/chat/chat-attachments-service');
  return {
    policy: {
      purpose: 'chat',
      maxBytes: getChatMaxSizeForMime(declared.mimeType),
      allowedMimeTypes: [...CHAT_ALLOWED_MIME_TYPES],
    },
    async createReference(object) {
      const attachment = await prisma.internalChatAttachment.create({
        data: {
          messageId: null,
          channelId,
          uploadedBy: actor.id,
          fileName: object.originalName,
          mimeType: declared.mimeType,
          sizeBytes: declared.sizeBytes,
          storagePath: null,
          storageObjectId: object.id,
          width: null,
          height: null,
        },
      });
      return { referenceId: attachment.id };
    },
  };
});

registerFileAccessResolver('ai_attachment', async (actor, object) => {
  if (!hasPermission(actor, 'assistant.use')) return false;
  const refs = await prisma.aiAttachment.findMany({
    where: { storageObjectId: object.id },
    select: { conversationId: true },
  });
  for (const ref of refs) {
    if (await ownsConversation(actor, ref.conversationId)) return true;
  }
  return false;
});

registerFileAccessResolver('ai_artifact', async (actor, object) => {
  if (!hasPermission(actor, 'assistant.use')) return false;
  const refs = await prisma.aiArtifact.findMany({
    where: { storageObjectId: object.id },
    select: { conversationId: true },
  });
  for (const ref of refs) {
    if (await ownsConversation(actor, ref.conversationId)) return true;
  }
  return false;
});

registerFileAccessResolver('chat', async (actor, object) => {
  if (!hasPermission(actor, 'chat.use')) return false;
  const refs = await prisma.internalChatAttachment.findMany({
    where: { storageObjectId: object.id },
    select: {
      channelId: true,
      uploadedBy: true,
      message: { select: { channelId: true, deletedAt: true } },
    },
  });
  for (const ref of refs) {
    // The uploader may always see their own pending (unsent) file.
    if (!ref.message && ref.uploadedBy === actor.id) return true;
    const channelId = ref.message?.channelId ?? ref.channelId;
    if (channelId && (await isChannelMember(actor, channelId))) return true;
  }
  return false;
});
