import { createHash } from 'crypto';
import { PassThrough, Transform } from 'stream';
import { prisma } from '@/lib/prisma';
import { getBackupDriver, getObjectStorageDriver } from './drivers';
import type { BucketAlias } from './storage-config';
import { getStorageState, setStorageState } from './storage-settings-service';

/**
 * Incremental daily backup to a SEPARATE storage account.
 *
 * - Copies every READY object created/updated since the last checkpoint.
 * - Writes a manifest (objects, references, checksums) next to the copies.
 * - Respects each object's original `expiresAt`: expired recordings and
 *   transcripts are never backed up, and the manifest records the expiry so a
 *   restore cannot silently extend retention.
 * - Production credentials cannot delete the backup: the backup driver only
 *   ever writes; deletion lives in the backup account's own lifecycle rules.
 *
 * Recovery objective: up to 24h of changes between backups. Restore time must
 * be measured with a real test before promising an SLA.
 */

const CHECKPOINT_KEY = 'backup:checkpoint';

interface BackupCheckpoint {
  lastRunAt: string | null;
  lastManifestKey: string | null;
  objectsBackedUp: number;
}

interface ManifestEntry {
  objectId: string;
  purpose: string;
  key: string;
  backupKey: string;
  sizeBytes: string;
  sha256: string | null;
  expiresAt: string | null;
  retentionPolicy: string;
  references: { aiAttachments: number; aiArtifacts: number; chatAttachments: number };
}

export interface BackupRunResult {
  skipped?: boolean;
  reason?: string;
  copied: number;
  skippedExpired: number;
  failed: number;
  bytes: number;
  manifestKey: string | null;
}

function backupKeyFor(objectId: string, versionId: string): string {
  return `backup/${objectId}/${versionId}`;
}

export async function runIncrementalBackup(
  options: {
    signal?: AbortSignal;
    onProgress?: (percent: number) => Promise<void> | void;
  } = {}
): Promise<BackupRunResult> {
  const backup = getBackupDriver();
  if (!backup) {
    return {
      skipped: true,
      reason: 'R2_BACKUP_* no configurado',
      copied: 0,
      skippedExpired: 0,
      failed: 0,
      bytes: 0,
      manifestKey: null,
    };
  }
  const primary = getObjectStorageDriver();
  const checkpoint = (await getStorageState<BackupCheckpoint>(CHECKPOINT_KEY)) ?? {
    lastRunAt: null,
    lastManifestKey: null,
    objectsBackedUp: 0,
  };
  const since = checkpoint.lastRunAt ? new Date(checkpoint.lastRunAt) : new Date(0);
  const runStartedAt = new Date();

  const candidates = await prisma.storageObject.findMany({
    where: {
      status: 'ready',
      deletedAt: null,
      bucketAlias: { not: 'legacy' },
      updatedAt: { gt: since },
    },
    orderBy: { updatedAt: 'asc' },
    take: 5000,
  });

  const manifest: ManifestEntry[] = [];
  const result: BackupRunResult = {
    copied: 0,
    skippedExpired: 0,
    failed: 0,
    bytes: 0,
    manifestKey: null,
  };
  let i = 0;
  for (const object of candidates) {
    if (options.signal?.aborted) break;
    i++;
    if (object.expiresAt && object.expiresAt.getTime() <= Date.now()) {
      result.skippedExpired++;
      continue;
    }
    try {
      const src = await primary.getObjectStream(
        object.bucketAlias as BucketAlias,
        object.objectKey
      );
      if (!src) throw new Error('Objeto ausente en el almacenamiento primario');
      const hash = createHash('sha256');
      const tap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      const pass = new PassThrough();
      src.stream.pipe(tap).pipe(pass);
      const backupKey = backupKeyFor(object.id, object.versionId);
      await backup.putObject({
        bucket: 'files',
        key: backupKey,
        body: pass,
        contentType: object.detectedMimeType ?? object.declaredMimeType,
        contentLength: src.totalSize,
      });
      const digest = hash.digest('hex');
      if (object.sha256 && digest !== object.sha256) {
        throw new Error('Checksum leído distinto al registrado');
      }
      const [aiAttachments, aiArtifacts, chatAttachments] = await Promise.all([
        prisma.aiAttachment.count({ where: { storageObjectId: object.id } }),
        prisma.aiArtifact.count({ where: { storageObjectId: object.id } }),
        prisma.internalChatAttachment.count({ where: { storageObjectId: object.id } }),
      ]);
      manifest.push({
        objectId: object.id,
        purpose: object.purpose,
        key: `${object.bucketAlias}/${object.objectKey}`,
        backupKey,
        sizeBytes: object.sizeBytes.toString(),
        sha256: object.sha256 ?? digest,
        expiresAt: object.expiresAt?.toISOString() ?? null,
        retentionPolicy: object.retentionPolicy,
        references: { aiAttachments, aiArtifacts, chatAttachments },
      });
      const meta = (object.metadata as Record<string, unknown> | null) ?? {};
      await prisma.storageObject.update({
        where: { id: object.id },
        data: {
          metadata: {
            ...meta,
            backup: { at: runStartedAt.toISOString(), key: backupKey, sha256: digest },
          },
        },
      });
      result.copied++;
      result.bytes += src.totalSize;
    } catch (err) {
      result.failed++;
      console.error(
        JSON.stringify({
          component: 'storage-backup',
          event: 'object_failed',
          objectId: object.id,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
    if (i % 25 === 0)
      await options.onProgress?.(Math.round((i / Math.max(1, candidates.length)) * 95));
  }

  const manifestKey = `manifests/${runStartedAt.toISOString().replace(/[:.]/g, '-')}.json`;
  const manifestBody = Buffer.from(
    JSON.stringify(
      { generatedAt: runStartedAt.toISOString(), since: since.toISOString(), entries: manifest },
      null,
      2
    )
  );
  await backup.putObject({
    bucket: 'files',
    key: manifestKey,
    body: manifestBody,
    contentType: 'application/json',
    contentLength: manifestBody.length,
  });
  result.manifestKey = manifestKey;

  await setStorageState(CHECKPOINT_KEY, {
    lastRunAt: runStartedAt.toISOString(),
    lastManifestKey: manifestKey,
    objectsBackedUp: checkpoint.objectsBackedUp + result.copied,
  } satisfies BackupCheckpoint);
  await options.onProgress?.(100);
  return result;
}

export interface RestoreResult {
  objectId: string;
  restored: boolean;
  reason?: string;
  sha256?: string;
}

/**
 * Restores one object from the backup account into the primary storage,
 * verifying the checksum before marking it READY again.
 */
export async function restoreObjectFromBackup(objectId: string): Promise<RestoreResult> {
  const backup = getBackupDriver();
  if (!backup) return { objectId, restored: false, reason: 'Respaldo no configurado' };
  const primary = getObjectStorageDriver();
  const object = await prisma.storageObject.findUnique({ where: { id: objectId } });
  if (!object) return { objectId, restored: false, reason: 'Objeto inexistente' };
  if (object.expiresAt && object.expiresAt.getTime() <= Date.now()) {
    return {
      objectId,
      restored: false,
      reason: 'El objeto ya venció; restaurarlo extendería su retención',
    };
  }
  const meta = (object.metadata as Record<string, unknown> | null) ?? {};
  const backupInfo = meta.backup as { key?: string; sha256?: string } | undefined;
  const backupKey = backupInfo?.key ?? backupKeyFor(object.id, object.versionId);
  const src = await backup.getObjectStream('files', backupKey);
  if (!src) return { objectId, restored: false, reason: 'Copia de respaldo ausente' };

  const hash = createHash('sha256');
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  const pass = new PassThrough();
  src.stream.pipe(tap).pipe(pass);
  await primary.putObject({
    bucket: object.bucketAlias as BucketAlias,
    key: object.objectKey,
    body: pass,
    contentType: object.detectedMimeType ?? object.declaredMimeType,
    contentLength: src.totalSize,
  });
  const digest = hash.digest('hex');
  const expected = object.sha256 ?? backupInfo?.sha256 ?? null;
  if (expected && digest !== expected) {
    await primary.deleteObject(object.bucketAlias as BucketAlias, object.objectKey);
    return {
      objectId,
      restored: false,
      reason: 'Checksum del respaldo no coincide',
      sha256: digest,
    };
  }
  await prisma.storageObject.update({
    where: { id: objectId },
    data: {
      status: 'ready',
      sha256: digest,
      metadata: { ...meta, restoredAt: new Date().toISOString() },
    },
  });
  return { objectId, restored: true, sha256: digest };
}

export async function getBackupCheckpoint(): Promise<BackupCheckpoint | null> {
  return getStorageState<BackupCheckpoint>(CHECKPOINT_KEY);
}
