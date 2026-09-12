import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import {
  registerFileAccessResolver,
  registerUploadTargetResolver,
  resolveFileAccess,
} from '@/modules/storage/storage-access';
import { StorageError } from '@/modules/storage/storage-service';
import { canAccessAccount, isInboxAdmin } from './comms-access';

/**
 * Storage integration for communications.
 *
 * - Upload target `comm_conversation`: attachments composed in the inbox
 *   (image / PDF / audio, 25 MB). No module record is created at upload
 *   time; the object ids travel as `mediaObjectIds` when the message is sent
 *   and the service re-validates that the sender may read them.
 * - Upload target `internal_request`: files attached to internal requests.
 * - Access resolver `comm_media`: readable by inbox users whose teams share
 *   the account of a message referencing the object, by the uploader while
 *   the file is still unsent, by requester/assignee of a request referencing
 *   it, and by channel administrators.
 */

export const COMM_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

export const COMM_MEDIA_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/aac',
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/amr',
  'video/mp4',
];

let registered = false;

export function registerCommsStorageResolvers(): void {
  if (registered) return;
  registered = true;

  registerUploadTargetResolver('comm_conversation', async (actor, conversationId) => {
    if (!hasPermission(actor, 'inbox.use') && !isInboxAdmin(actor)) {
      throw new StorageError('Sin permiso para adjuntar archivos', 'forbidden', 403);
    }
    const conversation = await prisma.commConversation.findUnique({
      where: { id: conversationId },
      select: { id: true, account: { select: { teamKeys: true } } },
    });
    if (!conversation || !canAccessAccount(actor, conversation.account)) {
      throw new StorageError('Conversación no encontrada', 'not_found', 404);
    }
    return {
      policy: {
        purpose: 'comm_media',
        maxBytes: COMM_MEDIA_MAX_BYTES,
        allowedMimeTypes: COMM_MEDIA_MIME_TYPES,
      },
    };
  });

  registerUploadTargetResolver('internal_request', async (actor, requestId) => {
    if (!hasPermission(actor, 'requests.use')) {
      throw new StorageError('Sin permiso para adjuntar archivos', 'forbidden', 403);
    }
    if (requestId !== 'new') {
      const request = await prisma.internalRequest.findUnique({
        where: { id: requestId },
        select: { requesterUserId: true, assigneeUserId: true },
      });
      const allowed =
        request &&
        (request.requesterUserId === actor.id ||
          request.assigneeUserId === actor.id ||
          isInboxAdmin(actor));
      if (!allowed) throw new StorageError('Solicitud no encontrada', 'not_found', 404);
    }
    return {
      policy: {
        purpose: 'comm_media',
        maxBytes: COMM_MEDIA_MAX_BYTES,
        allowedMimeTypes: [...COMM_MEDIA_MIME_TYPES, 'text/plain', 'text/csv'],
      },
    };
  });

  registerFileAccessResolver('comm_media', async (actor, object) => {
    const inboxUser = hasPermission(actor, 'inbox.use') || isInboxAdmin(actor);
    const requestsUser = hasPermission(actor, 'requests.use');
    if (!inboxUser && !requestsUser) return false;
    if (isInboxAdmin(actor)) return true;
    // The uploader may always see their own file (pending or sent).
    if (object.createdBy === actor.id) return true;

    if (inboxUser) {
      const messages = await prisma.commMessage.findMany({
        where: { mediaObjectIds: { has: object.id } },
        select: { account: { select: { teamKeys: true } } },
        take: 20,
      });
      if (messages.some((m) => canAccessAccount(actor, m.account))) return true;
    }
    if (requestsUser) {
      const request = await prisma.internalRequest.findFirst({
        where: {
          fileIds: { has: object.id },
          OR: [{ requesterUserId: actor.id }, { assigneeUserId: actor.id }],
        },
        select: { id: true },
      });
      if (request) return true;
    }
    return false;
  });
}

registerCommsStorageResolvers();

/** Returns only the ids the actor may read and that are ready to be delivered. */
export async function filterReadableObjectIds(
  actor: CurrentUser,
  objectIds: string[]
): Promise<{ ok: string[]; rejected: string[] }> {
  const ok: string[] = [];
  const rejected: string[] = [];
  for (const id of [...new Set(objectIds)]) {
    const decision = await resolveFileAccess(actor, id);
    if (decision && decision.allowed && decision.object.status === 'ready') ok.push(id);
    else rejected.push(id);
  }
  return { ok, rejected };
}
