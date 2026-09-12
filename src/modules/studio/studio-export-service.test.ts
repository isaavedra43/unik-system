import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { makeActor, makeTestPng, sampleContent } from './studio-test-utils';

/**
 * Export pipeline against the in-memory Prisma stub and the DISK object
 * storage driver (local emulator): request → job enqueued → worker silent →
 * inline fallback → render → verify → store → `ready`. A failing verification
 * must leave the export `failed` with no storage object and no link.
 */

const db = await vi.hoisted(async () => {
  const { createPrismaStub } = await import('./studio-test-utils');
  return createPrismaStub();
});
const enqueued: Array<{ type: string; payload: unknown; dedupeKey?: string }> = [];
const cancelled: string[] = [];
const published: Array<{ channel: string; type: string; payload: unknown }> = [];
let cancelResult = true;

vi.mock('@/lib/prisma', () => ({ prisma: db.prisma }));
vi.mock('@/modules/jobs/job-queue', () => ({
  JOB_PRIORITY: { interactive: 10, normal: 100, maintenance: 300, bulk: 500 },
  enqueueJob: async (input: { type: string; payload: unknown; dedupeKey?: string }) => {
    enqueued.push(input);
    return { id: `job-${enqueued.length}`, status: 'pending', deduplicated: false };
  },
  waitForJob: async () => null,
  cancelJob: async (id: string) => {
    cancelled.push(id);
    return cancelResult;
  },
}));
vi.mock('@/modules/realtime/realtime-service', () => ({
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}`, upload: (id: string) => `upload:${id}` },
  publishRealtime: async (channel: string, type: string, payload: unknown) => {
    published.push({ channel, type, payload });
  },
}));
vi.mock('@/modules/storage/storage-settings-service', () => ({
  getStorageSettings: async () => ({
    partSizeBytes: 5 * 1024 * 1024,
    multipartThresholdBytes: 5 * 1024 * 1024,
    maxPartsPerUpload: 10_000,
    uploadSessionTtlHours: 24,
    uploadUrlTtlSeconds: 900,
    signedUrlTtlSeconds: 300,
    perUserDailyQuotaBytes: 0,
    environmentDailyQuotaBytes: 0,
    maxZipExpansionBytes: 512 * 1024 * 1024,
    maxZipRatio: 100,
    maxZipEntries: 10_000,
    inlineValidationWaitMs: 0,
    recordingRetentionDays: 30,
    transcriptRetentionDays: 90,
    cleanupEnabled: true,
    backupEnabled: false,
    preferSignedUrls: true,
  }),
  getStorageState: async () => null,
  setStorageState: async () => undefined,
}));

import { DiskObjectStorageDriver } from '@/modules/storage/drivers/disk-driver';
import { setObjectStorageDriverForTests } from '@/modules/storage/drivers';
import {
  MemoryStorageRepository,
  setStorageRepositoryForTests,
} from '@/modules/storage/storage-repository';
import { openObjectStream, saveGeneratedFile } from '@/modules/storage/storage-service';
import { createDocument, approveDocument } from './studio-service';
import { getExport, listExports, requestExport, runStudioExport } from './studio-export-service';
import { STUDIO_EXPORT_FORMATS } from './studio-exporters';

let root: string;
let repo: MemoryStorageRepository;
const actor = makeActor();
const approver = makeActor({ id: 'u2', permissionKeys: ['studio.use', 'studio.approve'] as never });

beforeEach(async () => {
  process.env.STORAGE_SIGNING_SECRET = 'test-secret';
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'unik-studio-export-'));
  const driver = new DiskObjectStorageDriver(root, {
    files: 'files',
    recordings: 'recordings',
    quarantine: 'quarantine',
  });
  repo = new MemoryStorageRepository();
  setObjectStorageDriverForTests(driver, null);
  setStorageRepositoryForTests(repo);
  db.reset();
  enqueued.length = 0;
  cancelled.length = 0;
  published.length = 0;
  cancelResult = true;
  await db.prisma.user.create({ data: { id: 'u1', name: 'Usuario Uno' } });
});

afterEach(async () => {
  setObjectStorageDriverForTests(undefined, undefined);
  setStorageRepositoryForTests(null);
  await fsp.rm(root, { recursive: true, force: true });
});

async function readAll(objectId: string): Promise<Buffer> {
  const object = await repo.getObject(objectId);
  if (!object) throw new Error('object missing');
  const res = await openObjectStream(object);
  if (!res) throw new Error('stream missing');
  const chunks: Buffer[] = [];
  for await (const chunk of res.stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('requestExport (job + inline fallback)', () => {
  it.each(STUDIO_EXPORT_FORMATS)(
    '%s: renders, verifies, stores and marks ready with an access path',
    async (format) => {
      const image = await saveGeneratedFile({
        createdBy: actor.id,
        purpose: 'document',
        fileName: 'grafica.png',
        mimeType: 'image/png',
        source: { buffer: makeTestPng(12, 8) },
      });
      const doc = await createDocument(actor, {
        title: `Cierre ${format}`,
        kind: 'document',
        content: sampleContent(image.id),
      });
      const result = await requestExport(actor, doc.id, format);

      expect(enqueued[0]).toMatchObject({
        type: 'studio.export',
        dedupeKey: `studio.export:${result.id}`,
      });
      expect(cancelled).toEqual(['job-1']);
      expect(result.status, JSON.stringify(result.verification)).toBe('ready');
      expect(result.verification?.ok).toBe(true);
      expect(result.storageObjectId).toBeTruthy();
      expect(result.accessPath).toBe(
        `/app/files/api/objects/${result.storageObjectId}/access?disposition=attachment`
      );
      expect(result.fileName?.endsWith(`.${format}`)).toBe(true);

      const object = await repo.getObject(result.storageObjectId!);
      expect(object?.purpose).toBe('document');
      expect(object?.retentionPolicy).toBe('default');
      expect(object?.status).toBe('ready');
      const bytes = await readAll(result.storageObjectId!);
      expect(bytes.length).toBe(Number(object?.sizeBytes));
      expect(published.at(-1)).toMatchObject({ channel: 'user:u1', type: 'studio.export' });

      const listed = await listExports(actor, doc.id);
      expect(listed[0].id).toBe(result.id);
      expect((await getExport(actor, result.id)).status).toBe('ready');
    }
  );

  it('stores exports of approved documents with protected retention', async () => {
    const doc = await createDocument(approver, {
      title: 'Aprobado',
      kind: 'document',
      content: sampleContent(),
    });
    await approveDocument(approver, doc.id);
    const result = await requestExport(approver, doc.id, 'md');
    expect(result.status).toBe('ready');
    expect((await repo.getObject(result.storageObjectId!))?.retentionPolicy).toBe('protected');
  });

  it('does not run inline when a worker already claimed the job; the state is returned as-is', async () => {
    cancelResult = false;
    const doc = await createDocument(actor, {
      title: 'Ocupado',
      kind: 'document',
      content: sampleContent(),
    });
    const result = await requestExport(actor, doc.id, 'html');
    expect(result.status).toBe('processing');
    expect(result.accessPath).toBeNull();
  });

  it('denies exports of documents the actor cannot view', async () => {
    const doc = await createDocument(actor, {
      title: 'Privado',
      kind: 'document',
      content: sampleContent(),
    });
    const other = makeActor({ id: 'u3' });
    await expect(requestExport(other, doc.id, 'pdf')).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      requestExport(makeActor({ permissionKeys: [] as never }), doc.id, 'pdf')
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('runStudioExport', () => {
  it('marks the export failed (no file, no link) when verification fails', async () => {
    const doc = await createDocument(actor, {
      title: 'Falla',
      kind: 'document',
      content: sampleContent(),
    });
    const row = await db.prisma.studioExport.create({
      data: {
        documentId: doc.id,
        versionId: doc.currentVersionId,
        format: 'html',
        status: 'processing',
        createdBy: actor.id,
      },
    });
    const result = await runStudioExport(row.id as string, {
      verify: async () => ({
        ok: false,
        checks: [{ name: 'figures', ok: false, detail: 'Faltan 2 de 30 cifras' }],
      }),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('La verificación del renderizado falló');
    expect(result.error).toContain('Faltan 2 de 30 cifras');
    expect(result.storageObjectId).toBeNull();
    expect(result.accessPath).toBeNull();
    expect(repo.objects.size).toBe(0);
  });

  it('marks the export failed when rendering throws and is idempotent afterwards', async () => {
    const doc = await createDocument(actor, {
      title: 'Error',
      kind: 'document',
      content: sampleContent(),
    });
    const row = await db.prisma.studioExport.create({
      data: {
        documentId: doc.id,
        versionId: doc.currentVersionId,
        format: 'pdf',
        status: 'processing',
        createdBy: actor.id,
      },
    });
    const failed = await runStudioExport(row.id as string, {
      render: async () => {
        throw new Error('pdfkit explotó');
      },
    });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('pdfkit explotó');
    const again = await runStudioExport(row.id as string);
    expect(again.status).toBe('failed');
  });
});
