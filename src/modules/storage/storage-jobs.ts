import { prisma } from '@/lib/prisma';
import { registerJobHandler, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import { pruneRealtimeEvents } from '@/modules/realtime/realtime-service';
import {
  STORAGE_VALIDATE_JOB,
  cleanupAbandonedUploads,
  cleanupExpiredObjects,
  validateAndPromote,
} from './storage-service';
import { getStorageSettings } from './storage-settings-service';

/**
 * Background jobs owned by the storage module.
 *
 * - storage.validate_object   → content validation + promotion (per upload)
 * - storage.cleanup           → hourly: abandoned uploads (24h), expired
 *                               objects, orphan attachment rows, old events
 * - storage.backup_incremental→ daily incremental backup (see backup service)
 * - storage.migrate           → on-demand legacy migration (see migration service)
 */

export const STORAGE_CLEANUP_JOB = 'storage.cleanup';
export const STORAGE_BACKUP_JOB = 'storage.backup_incremental';
export const STORAGE_MIGRATE_JOB = 'storage.migrate';
export const STORAGE_RECONCILE_JOB = 'storage.reconcile';

interface ValidatePayload {
  objectId: string;
}

registerJobHandler<ValidatePayload>(
  STORAGE_VALIDATE_JOB,
  async (ctx) => {
    const result = await validateAndPromote(ctx.payload.objectId);
    ctx.log('validated', { objectId: ctx.payload.objectId, ...result });
    return result;
  },
  { timeoutMs: 30 * 60 * 1000 }
);

/**
 * Attachment rows whose object was rejected/aborted/expired are useless and
 * must not linger (they could otherwise be linked to a message later).
 */
async function removeDeadAttachmentRows(): Promise<{ ai: number; chat: number }> {
  const dead = { status: { in: ['rejected', 'aborted', 'deleted'] } };
  const ai = await prisma.aiAttachment.deleteMany({
    where: { messageId: null, storageObject: dead },
  });
  const chat = await prisma.internalChatAttachment.deleteMany({
    where: { messageId: null, storageObject: dead },
  });
  return { ai: ai.count, chat: chat.count };
}

/** Pending (unsent) attachments older than a day are dropped together with their objects. */
async function removeStalePendingAttachments(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const { deleteObjectIfUnreferenced } = await import('./storage-service');
  let removed = 0;
  const staleChat = await prisma.internalChatAttachment.findMany({
    where: { messageId: null, createdAt: { lt: cutoff }, storageObjectId: { not: null } },
    select: { id: true, storageObjectId: true },
    take: 500,
  });
  for (const row of staleChat) {
    await prisma.internalChatAttachment.delete({ where: { id: row.id } });
    if (row.storageObjectId) await deleteObjectIfUnreferenced(row.storageObjectId);
    removed++;
  }
  const staleAi = await prisma.aiAttachment.findMany({
    where: { messageId: null, createdAt: { lt: cutoff }, storageObjectId: { not: null } },
    select: { id: true, storageObjectId: true },
    take: 500,
  });
  for (const row of staleAi) {
    await prisma.aiAttachment.delete({ where: { id: row.id } });
    if (row.storageObjectId) await deleteObjectIfUnreferenced(row.storageObjectId);
    removed++;
  }
  return removed;
}

registerJobHandler(
  STORAGE_CLEANUP_JOB,
  async (ctx) => {
    const settings = await getStorageSettings();
    if (!settings.cleanupEnabled) return { skipped: true };
    const abandoned = await cleanupAbandonedUploads();
    await ctx.setProgress(30);
    const expired = await cleanupExpiredObjects();
    await ctx.setProgress(60);
    const dead = await removeDeadAttachmentRows();
    const stale = await removeStalePendingAttachments();
    await ctx.setProgress(90);
    const prunedEvents = await pruneRealtimeEvents(3);
    const result = { abandoned, expired, deadRows: dead, stalePending: stale, prunedEvents };
    ctx.log('cleanup', result);
    return result;
  },
  { timeoutMs: 20 * 60 * 1000 }
);

registerRecurringJob({
  type: STORAGE_CLEANUP_JOB,
  everyMs: 60 * 60 * 1000,
  priority: JOB_PRIORITY.maintenance,
});

registerJobHandler(
  STORAGE_BACKUP_JOB,
  async (ctx) => {
    const settings = await getStorageSettings();
    if (!settings.backupEnabled) return { skipped: true, reason: 'backupEnabled=false' };
    const { runIncrementalBackup } = await import('./storage-backup-service');
    return runIncrementalBackup({ signal: ctx.signal, onProgress: (p) => ctx.setProgress(p) });
  },
  { timeoutMs: 6 * 60 * 60 * 1000 }
);

registerRecurringJob({
  type: STORAGE_BACKUP_JOB,
  everyMs: 24 * 60 * 60 * 1000,
  priority: JOB_PRIORITY.maintenance,
});

interface MigratePayload {
  mode: 'inventory' | 'dry-run' | 'copy' | 'verify' | 'reconcile';
  batchSize?: number;
}

registerJobHandler<MigratePayload>(
  STORAGE_MIGRATE_JOB,
  async (ctx) => {
    const { runMigration } = await import('./storage-migration-service');
    return runMigration(ctx.payload.mode, {
      batchSize: ctx.payload.batchSize,
      signal: ctx.signal,
      onProgress: (p) => ctx.setProgress(p),
    });
  },
  { timeoutMs: 12 * 60 * 60 * 1000 }
);

registerJobHandler(
  STORAGE_RECONCILE_JOB,
  async (ctx) => {
    const { reconcileStorage } = await import('./storage-migration-service');
    return reconcileStorage({ signal: ctx.signal, onProgress: (p) => ctx.setProgress(p) });
  },
  { timeoutMs: 6 * 60 * 60 * 1000 }
);
