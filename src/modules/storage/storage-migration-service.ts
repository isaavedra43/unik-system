import { createHash } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { prisma } from '@/lib/prisma';
import { getObjectStorageDriver } from './drivers';
import type { BucketAlias } from './storage-config';
import {
  buildObjectKey,
  isLegacyPathAllowed,
  newVersionId,
  type StoragePurpose,
} from './storage-keys';
import { getStorageState, setStorageState } from './storage-settings-service';
import { normalizeMime } from './file-validation';
import { randomBytes } from 'crypto';

/**
 * Migration of legacy disk files into the object storage.
 *
 * Modes (each resumable, none deletes originals):
 *   inventory → dry-run → copy → verify → reconcile
 *
 * Source of truth: the DATABASE references (AiAttachment.storagePath,
 * InternalChatAttachment.storagePath, AiArtifact.storagePath) — never a
 * directory listing. Paths are validated to live inside the legacy
 * directories before any read. Several references to the same physical file
 * (forwarded messages) map to ONE StorageObject.
 *
 * The report is persisted in StorageConfig under `migration:report` after
 * every batch so an interrupted run continues where it stopped.
 */

export type MigrationMode = 'inventory' | 'dry-run' | 'copy' | 'verify' | 'reconcile';

export interface LegacyReference {
  table: 'AiAttachment' | 'InternalChatAttachment' | 'AiArtifact';
  id: string;
  storagePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number | null;
  createdBy: string | null;
  purpose: StoragePurpose;
}

export interface InventoryEntry {
  storagePath: string;
  present: boolean;
  allowed: boolean;
  sizeBytes: number | null;
  references: Array<{ table: LegacyReference['table']; id: string }>;
  purpose: StoragePurpose;
  mimeType: string;
  fileName: string;
  createdBy: string | null;
  sha256?: string;
  objectId?: string;
  copiedAt?: string;
  verifiedAt?: string;
  linkedAt?: string;
  error?: string;
}

export interface MigrationReport {
  version: 1;
  mode: MigrationMode;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  totals: {
    references: number;
    files: number;
    present: number;
    missing: number;
    disallowed: number;
    shared: number;
    copied: number;
    verified: number;
    linked: number;
    failed: number;
    bytes: number;
  };
  entries: Record<string, InventoryEntry>;
}

const REPORT_KEY = 'migration:report';

function bucketFor(purpose: StoragePurpose): BucketAlias {
  return purpose === 'recording' ? 'recordings' : 'files';
}

async function collectReferences(): Promise<LegacyReference[]> {
  const refs: LegacyReference[] = [];
  const ai = await prisma.aiAttachment.findMany({
    where: { storageObjectId: null, storagePath: { not: null } },
    select: {
      id: true,
      storagePath: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      uploadedBy: true,
    },
  });
  for (const a of ai) {
    refs.push({
      table: 'AiAttachment',
      id: a.id,
      storagePath: a.storagePath!,
      fileName: a.fileName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      createdBy: a.uploadedBy,
      purpose: 'ai_attachment',
    });
  }
  const chat = await prisma.internalChatAttachment.findMany({
    where: { storageObjectId: null, storagePath: { not: null } },
    select: {
      id: true,
      storagePath: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      uploadedBy: true,
      message: { select: { senderId: true } },
    },
  });
  for (const c of chat) {
    refs.push({
      table: 'InternalChatAttachment',
      id: c.id,
      storagePath: c.storagePath!,
      fileName: c.fileName,
      mimeType: c.mimeType,
      sizeBytes: c.sizeBytes,
      createdBy: c.uploadedBy ?? c.message?.senderId ?? null,
      purpose: 'chat',
    });
  }
  const artifacts = await prisma.aiArtifact.findMany({
    where: { storageObjectId: null, storagePath: { not: null } },
    select: { id: true, storagePath: true, meta: true, conversation: { select: { userId: true } } },
  });
  for (const a of artifacts) {
    const meta = (a.meta as Record<string, unknown> | null) ?? {};
    refs.push({
      table: 'AiArtifact',
      id: a.id,
      storagePath: a.storagePath!,
      fileName: typeof meta.filename === 'string' ? meta.filename : path.basename(a.storagePath!),
      mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : 'application/octet-stream',
      sizeBytes: typeof meta.sizeBytes === 'number' ? meta.sizeBytes : null,
      createdBy: a.conversation?.userId ?? null,
      purpose: 'ai_artifact',
    });
  }
  return refs;
}

async function loadReport(): Promise<MigrationReport | null> {
  return getStorageState<MigrationReport>(REPORT_KEY);
}

async function saveReport(report: MigrationReport): Promise<void> {
  report.updatedAt = new Date().toISOString();
  await setStorageState(REPORT_KEY, report);
}

function newReport(mode: MigrationMode): MigrationReport {
  return {
    version: 1,
    mode,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    totals: {
      references: 0,
      files: 0,
      present: 0,
      missing: 0,
      disallowed: 0,
      shared: 0,
      copied: 0,
      verified: 0,
      linked: 0,
      failed: 0,
      bytes: 0,
    },
    entries: {},
  };
}

function recomputeTotals(report: MigrationReport): void {
  const t = report.totals;
  t.files = 0;
  t.present = 0;
  t.missing = 0;
  t.disallowed = 0;
  t.shared = 0;
  t.copied = 0;
  t.verified = 0;
  t.linked = 0;
  t.failed = 0;
  t.bytes = 0;
  t.references = 0;
  for (const entry of Object.values(report.entries)) {
    t.files++;
    t.references += entry.references.length;
    if (!entry.allowed) t.disallowed++;
    else if (entry.present) {
      t.present++;
      t.bytes += entry.sizeBytes ?? 0;
    } else t.missing++;
    if (entry.references.length > 1) t.shared++;
    if (entry.copiedAt) t.copied++;
    if (entry.verifiedAt) t.verified++;
    if (entry.linkedAt) t.linked++;
    if (entry.error) t.failed++;
  }
}

/** Step 1 — inventory: which files exist, which are missing, which are shared. */
export async function buildInventory(existing?: MigrationReport | null): Promise<MigrationReport> {
  const report = existing ?? newReport('inventory');
  report.mode = 'inventory';
  const refs = await collectReferences();
  const byPath = new Map<string, InventoryEntry>();
  for (const [key, entry] of Object.entries(report.entries)) byPath.set(key, entry);

  for (const ref of refs) {
    const key = ref.storagePath;
    let entry = byPath.get(key);
    if (!entry) {
      const allowed = isLegacyPathAllowed(ref.storagePath);
      let present = false;
      let sizeBytes: number | null = null;
      if (allowed) {
        try {
          const stat = await fsp.stat(ref.storagePath);
          present = stat.isFile();
          sizeBytes = stat.size;
        } catch {
          present = false;
        }
      }
      entry = {
        storagePath: ref.storagePath,
        present,
        allowed,
        sizeBytes,
        references: [],
        purpose: ref.purpose,
        mimeType: normalizeMime(ref.mimeType),
        fileName: ref.fileName,
        createdBy: ref.createdBy,
      };
      byPath.set(key, entry);
    }
    if (!entry.references.some((r) => r.table === ref.table && r.id === ref.id)) {
      entry.references.push({ table: ref.table, id: ref.id });
    }
  }
  report.entries = Object.fromEntries(byPath);
  recomputeTotals(report);
  await saveReport(report);
  return report;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(filePath)
      .on('data', (c: string | Buffer) => {
        hash.update(c);
      })
      .on('end', () => resolve())
      .on('error', reject);
  });
  return hash.digest('hex');
}

async function hashRemote(
  bucket: BucketAlias,
  key: string
): Promise<{ sha256: string; size: number } | null> {
  const driver = getObjectStorageDriver();
  const res = await driver.getObjectStream(bucket, key);
  if (!res) return null;
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of res.stream as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}

export interface MigrationRunOptions {
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (percent: number) => Promise<void> | void;
}

/** Step 2 — dry-run: inventory + checksums, no writes to storage. */
async function runDryRun(
  report: MigrationReport,
  options: MigrationRunOptions
): Promise<MigrationReport> {
  report.mode = 'dry-run';
  const entries = Object.values(report.entries).filter((e) => e.allowed && e.present && !e.sha256);
  let done = 0;
  for (const entry of entries) {
    if (options.signal?.aborted) break;
    try {
      entry.sha256 = await sha256File(entry.storagePath);
      delete entry.error;
    } catch (err) {
      entry.error = `checksum: ${err instanceof Error ? err.message : String(err)}`;
    }
    done++;
    if (done % (options.batchSize ?? 50) === 0) {
      recomputeTotals(report);
      await saveReport(report);
      await options.onProgress?.(Math.round((done / Math.max(1, entries.length)) * 100));
    }
  }
  recomputeTotals(report);
  await saveReport(report);
  return report;
}

/** Step 3 — copy: upload each present file to its final key and create the StorageObject. */
async function runCopy(
  report: MigrationReport,
  options: MigrationRunOptions
): Promise<MigrationReport> {
  report.mode = 'copy';
  const driver = getObjectStorageDriver();
  const entries = Object.values(report.entries).filter(
    (e) => e.allowed && e.present && !e.copiedAt
  );
  let done = 0;
  for (const entry of entries) {
    if (options.signal?.aborted) break;
    try {
      if (!entry.sha256) entry.sha256 = await sha256File(entry.storagePath);
      const objectId = entry.objectId ?? `o${randomBytes(12).toString('base64url')}`;
      const versionId = newVersionId();
      const key = buildObjectKey(entry.purpose, objectId, versionId);
      const bucket = bucketFor(entry.purpose);
      const stat = await fsp.stat(entry.storagePath);
      await driver.putObject({
        bucket,
        key,
        body: fs.createReadStream(entry.storagePath),
        contentType: entry.mimeType,
        contentLength: stat.size,
      });
      const head = await driver.headObject(bucket, key);
      if (!head || head.sizeBytes !== stat.size) {
        await driver.deleteObject(bucket, key);
        throw new Error('El tamaño en el destino no coincide');
      }
      const existing = entry.objectId
        ? await prisma.storageObject.findUnique({ where: { id: entry.objectId } })
        : null;
      if (!existing) {
        await prisma.storageObject.create({
          data: {
            id: objectId,
            provider: driver.provider,
            bucketAlias: bucket,
            objectKey: key,
            versionId,
            originalName: entry.fileName,
            declaredMimeType: entry.mimeType,
            detectedMimeType: entry.mimeType,
            sizeBytes: BigInt(stat.size),
            sha256: entry.sha256,
            status: 'ready',
            createdBy: entry.createdBy,
            purpose: entry.purpose,
            legacyPath: entry.storagePath,
            metadata: { migrated: true, migratedAt: new Date().toISOString(), validation: null },
          },
        });
      } else {
        await prisma.storageObject.update({
          where: { id: objectId },
          data: {
            objectKey: key,
            versionId,
            bucketAlias: bucket,
            status: 'ready',
            sizeBytes: BigInt(stat.size),
            sha256: entry.sha256,
          },
        });
      }
      entry.objectId = objectId;
      entry.sizeBytes = stat.size;
      entry.copiedAt = new Date().toISOString();
      delete entry.error;
    } catch (err) {
      entry.error = `copy: ${err instanceof Error ? err.message : String(err)}`;
    }
    done++;
    if (done % (options.batchSize ?? 25) === 0) {
      recomputeTotals(report);
      await saveReport(report);
      await options.onProgress?.(Math.round((done / Math.max(1, entries.length)) * 100));
    }
  }
  recomputeTotals(report);
  await saveReport(report);
  return report;
}

/** Step 4 — verify: re-hash the remote copy and link the original records. */
async function runVerify(
  report: MigrationReport,
  options: MigrationRunOptions
): Promise<MigrationReport> {
  report.mode = 'verify';
  const entries = Object.values(report.entries).filter(
    (e) => e.copiedAt && e.objectId && (!e.verifiedAt || !e.linkedAt)
  );
  let done = 0;
  for (const entry of entries) {
    if (options.signal?.aborted) break;
    try {
      const object = await prisma.storageObject.findUnique({ where: { id: entry.objectId! } });
      if (!object) throw new Error('StorageObject inexistente');
      if (!entry.verifiedAt) {
        const remote = await hashRemote(object.bucketAlias as BucketAlias, object.objectKey);
        if (!remote) throw new Error('Objeto ausente en el destino');
        if (remote.sha256 !== entry.sha256 || remote.size !== entry.sizeBytes) {
          throw new Error('Checksum del destino no coincide con el original');
        }
        entry.verifiedAt = new Date().toISOString();
      }
      if (!entry.linkedAt) {
        for (const ref of entry.references) {
          if (ref.table === 'AiAttachment') {
            await prisma.aiAttachment.updateMany({
              where: { id: ref.id, storageObjectId: null },
              data: { storageObjectId: object.id },
            });
          } else if (ref.table === 'InternalChatAttachment') {
            await prisma.internalChatAttachment.updateMany({
              where: { id: ref.id, storageObjectId: null },
              data: { storageObjectId: object.id },
            });
          } else {
            await prisma.aiArtifact.updateMany({
              where: { id: ref.id, storageObjectId: null },
              data: { storageObjectId: object.id },
            });
          }
        }
        entry.linkedAt = new Date().toISOString();
      }
      delete entry.error;
    } catch (err) {
      entry.error = `verify: ${err instanceof Error ? err.message : String(err)}`;
    }
    done++;
    if (done % (options.batchSize ?? 25) === 0) {
      recomputeTotals(report);
      await saveReport(report);
      await options.onProgress?.(Math.round((done / Math.max(1, entries.length)) * 100));
    }
  }
  recomputeTotals(report);
  await saveReport(report);
  return report;
}

export interface ReconcileResult {
  objectsWithoutReferences: number;
  referencesWithoutObject: number;
  missingInStorage: number;
  orphanKeysInStorage: number;
  markedMissing: string[];
  orphanKeys: string[];
}

/**
 * Step 5 — reconcile: compare DB and storage in both directions.
 * - objects READY whose bytes are gone → status "missing"
 * - references pointing at deleted objects
 * - storage keys with no StorageObject row (orphans from a failed DB write)
 * Nothing is deleted here; the result is a report for the administrator.
 */
export async function reconcileStorage(
  options: MigrationRunOptions = {}
): Promise<ReconcileResult> {
  const driver = getObjectStorageDriver();
  const result: ReconcileResult = {
    objectsWithoutReferences: 0,
    referencesWithoutObject: 0,
    missingInStorage: 0,
    orphanKeysInStorage: 0,
    markedMissing: [],
    orphanKeys: [],
  };

  const objects = await prisma.storageObject.findMany({
    where: {
      status: { in: ['ready', 'missing'] },
      deletedAt: null,
      bucketAlias: { not: 'legacy' },
    },
    select: { id: true, bucketAlias: true, objectKey: true, status: true },
  });
  const knownKeys = new Set<string>();
  let i = 0;
  for (const object of objects) {
    if (options.signal?.aborted) break;
    knownKeys.add(`${object.bucketAlias}/${object.objectKey}`);
    const head = await driver.headObject(object.bucketAlias as BucketAlias, object.objectKey);
    if (!head) {
      result.missingInStorage++;
      if (object.status !== 'missing') {
        await prisma.storageObject.update({
          where: { id: object.id },
          data: { status: 'missing' },
        });
        result.markedMissing.push(object.id);
      }
    } else if (object.status === 'missing') {
      await prisma.storageObject.update({ where: { id: object.id }, data: { status: 'ready' } });
    }
    const refs = await Promise.all([
      prisma.aiAttachment.count({ where: { storageObjectId: object.id } }),
      prisma.aiArtifact.count({ where: { storageObjectId: object.id } }),
      prisma.internalChatAttachment.count({ where: { storageObjectId: object.id } }),
    ]);
    if (refs.reduce((a, b) => a + b, 0) === 0) result.objectsWithoutReferences++;
    i++;
    if (i % 50 === 0)
      await options.onProgress?.(Math.round((i / Math.max(1, objects.length)) * 50));
  }

  const deletedIds = (
    await prisma.storageObject.findMany({ where: { status: 'deleted' }, select: { id: true } })
  ).map((o) => o.id);
  if (deletedIds.length > 0) {
    const [a, b, c] = await Promise.all([
      prisma.aiAttachment.count({ where: { storageObjectId: { in: deletedIds } } }),
      prisma.aiArtifact.count({ where: { storageObjectId: { in: deletedIds } } }),
      prisma.internalChatAttachment.count({ where: { storageObjectId: { in: deletedIds } } }),
    ]);
    result.referencesWithoutObject = a + b + c;
  }

  for (const bucket of ['files', 'recordings'] as BucketAlias[]) {
    let cursor: string | null = null;
    do {
      if (options.signal?.aborted) break;
      const page = await driver.listObjects(bucket, '', cursor, 1000);
      for (const obj of page.objects) {
        if (!knownKeys.has(`${bucket}/${obj.key}`)) {
          result.orphanKeysInStorage++;
          if (result.orphanKeys.length < 500) result.orphanKeys.push(`${bucket}/${obj.key}`);
        }
      }
      cursor = page.cursor;
    } while (cursor);
  }
  await options.onProgress?.(100);
  await setStorageState('reconcile:last', {
    at: new Date().toISOString(),
    ...result,
    orphanKeys: result.orphanKeys.slice(0, 100),
  });
  return result;
}

export async function runMigration(
  mode: MigrationMode,
  options: MigrationRunOptions = {}
): Promise<MigrationReport | ReconcileResult> {
  if (mode === 'reconcile') return reconcileStorage(options);
  const existing = await loadReport();
  let report =
    mode === 'inventory'
      ? await buildInventory(existing)
      : (existing ?? (await buildInventory(null)));
  if (mode === 'inventory') return report;
  // Every later step refreshes the inventory first so new legacy rows are never skipped.
  report = await buildInventory(report);
  if (mode === 'dry-run') return runDryRun(report, options);
  if (mode === 'copy') {
    report = await runDryRun(report, options);
    return runCopy(report, options);
  }
  return runVerify(report, options);
}

export async function getMigrationReport(): Promise<MigrationReport | null> {
  return loadReport();
}

export async function getLastReconcile(): Promise<Record<string, unknown> | null> {
  return getStorageState<Record<string, unknown>>('reconcile:last');
}
