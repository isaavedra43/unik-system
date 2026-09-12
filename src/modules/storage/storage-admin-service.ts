import { prisma } from '@/lib/prisma';
import { getStorageConfig } from './storage-config';
import { getStorageSettings, type StorageSettings } from './storage-settings-service';
import { getJobStats, listJobs } from '@/modules/jobs/job-queue';
import { getMigrationReport, getLastReconcile } from './storage-migration-service';
import { getBackupCheckpoint } from './storage-backup-service';

/**
 * Read model for the storage administration panel. Never exposes
 * credentials, bucket names beyond their aliases, keys or signed URLs.
 */

export interface StorageOverview {
  driver: 'r2' | 'disk';
  backupConfigured: boolean;
  buckets: Array<{ alias: string; configured: boolean }>;
  totals: {
    objects: number;
    readyBytes: string;
    byStatus: Record<string, number>;
    byPurpose: Record<string, { count: number; bytes: string }>;
    pendingUploads: number;
    legacyReferences: { aiAttachments: number; chatAttachments: number; aiArtifacts: number };
  };
  jobs: Record<string, number>;
  migration: {
    mode: string;
    updatedAt: string;
    totals: Record<string, number>;
  } | null;
  backup: {
    lastRunAt: string | null;
    lastManifestKey: string | null;
    objectsBackedUp: number;
  } | null;
  reconcile: Record<string, unknown> | null;
  settings: StorageSettings;
}

export async function getStorageOverview(): Promise<StorageOverview> {
  const config = getStorageConfig();
  const settings = await getStorageSettings();

  const [
    byStatus,
    byPurpose,
    pendingUploads,
    legacyAi,
    legacyChat,
    legacyArt,
    jobs,
    migration,
    backup,
    reconcile,
  ] = await Promise.all([
    prisma.storageObject.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.storageObject.groupBy({
      by: ['purpose'],
      where: { status: 'ready', deletedAt: null },
      _count: { _all: true },
      _sum: { sizeBytes: true },
    }),
    prisma.uploadSession.count({
      where: { status: { in: ['initiated', 'uploading', 'completing'] } },
    }),
    prisma.aiAttachment.count({ where: { storageObjectId: null, storagePath: { not: null } } }),
    prisma.internalChatAttachment.count({
      where: { storageObjectId: null, storagePath: { not: null } },
    }),
    prisma.aiArtifact.count({ where: { storageObjectId: null, storagePath: { not: null } } }),
    getJobStats(),
    getMigrationReport(),
    getBackupCheckpoint(),
    getLastReconcile(),
  ]);

  const statusMap: Record<string, number> = {};
  let objects = 0;
  for (const row of byStatus) {
    statusMap[row.status] = row._count._all;
    objects += row._count._all;
  }
  const purposeMap: Record<string, { count: number; bytes: string }> = {};
  let readyBytes = BigInt(0);
  for (const row of byPurpose) {
    const bytes = row._sum.sizeBytes ?? BigInt(0);
    purposeMap[row.purpose] = { count: row._count._all, bytes: bytes.toString() };
    readyBytes += bytes;
  }

  return {
    driver: config.driver,
    backupConfigured: Boolean(config.backup) || config.driver === 'disk',
    buckets: (['files', 'recordings', 'quarantine'] as const).map((alias) => ({
      alias,
      configured: Boolean(config.buckets[alias]),
    })),
    totals: {
      objects,
      readyBytes: readyBytes.toString(),
      byStatus: statusMap,
      byPurpose: purposeMap,
      pendingUploads,
      legacyReferences: {
        aiAttachments: legacyAi,
        chatAttachments: legacyChat,
        aiArtifacts: legacyArt,
      },
    },
    jobs,
    migration: migration
      ? { mode: migration.mode, updatedAt: migration.updatedAt, totals: migration.totals }
      : null,
    backup,
    reconcile,
    settings,
  };
}

export async function listStorageJobs(type?: string) {
  const jobs = await listJobs({ type, limit: 100 });
  return jobs.map((j) => ({
    id: j.id,
    type: j.type,
    status: j.status,
    progress: j.progress,
    attempts: j.attempts,
    lastError: j.lastError,
    createdAt: j.createdAt.toISOString(),
    completedAt: j.completedAt?.toISOString() ?? null,
    result: j.result,
  }));
}
