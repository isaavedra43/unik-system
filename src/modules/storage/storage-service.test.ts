import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';

/**
 * End-to-end contract of the upload pipeline against the DISK driver (the
 * local S3 emulator): initiate → sign → PUT parts → complete → validate →
 * promote, plus abort/retry/idempotency and reference-counted deletion.
 *
 * Prisma-backed collaborators (jobs, realtime, settings) are mocked; the
 * repository is the in-memory implementation.
 */

const settings = {
  partSizeBytes: 5 * 1024 * 1024,
  multipartThresholdBytes: 5 * 1024 * 1024,
  maxPartsPerUpload: 10_000,
  uploadSessionTtlHours: 24,
  uploadUrlTtlSeconds: 900,
  signedUrlTtlSeconds: 300,
  perUserDailyQuotaBytes: 100 * 1024 * 1024,
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
};

const enqueued: Array<{ type: string; payload: unknown }> = [];
const published: Array<{ channel: string; type: string }> = [];

vi.mock('@/modules/storage/storage-settings-service', () => ({
  getStorageSettings: async () => settings,
  getStorageState: async () => null,
  setStorageState: async () => undefined,
}));
vi.mock('@/modules/jobs/job-queue', () => ({
  JOB_PRIORITY: { interactive: 10, normal: 100, maintenance: 300, bulk: 500 },
  enqueueJob: async (input: { type: string; payload: unknown }) => {
    enqueued.push(input);
    return { id: `job-${enqueued.length}`, status: 'pending', deduplicated: false };
  },
  waitForJob: async () => null,
}));
vi.mock('@/modules/extensions/usage-meter', () => ({ recordUsage: async () => undefined }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  REALTIME_CHANNELS: { upload: (id: string) => `upload:${id}`, user: (id: string) => `user:${id}` },
  publishRealtime: async (channel: string, type: string) => {
    published.push({ channel, type });
  },
}));

import { DiskObjectStorageDriver } from './drivers/disk-driver';
import { setObjectStorageDriverForTests } from './drivers';
import { MemoryStorageRepository, setStorageRepositoryForTests } from './storage-repository';
import {
  abortUpload,
  authorizeDownload,
  cleanupAbandonedUploads,
  completeUpload,
  deleteObjectIfUnreferenced,
  initiateUpload,
  openObjectStream,
  receiveDiskPart,
  saveGeneratedFile,
  signUploadParts,
  StorageError,
  validateAndPromote,
  type UploadPolicy,
} from './storage-service';
import { verifyUploadPartToken } from './upload-tokens';

let root: string;
let driver: DiskObjectStorageDriver;
let repo: MemoryStorageRepository;

const buckets = { files: 'files', recordings: 'recordings', quarantine: 'quarantine' } as const;
const policy: UploadPolicy = {
  purpose: 'chat',
  maxBytes: 50 * 1024 * 1024,
  allowedMimeTypes: ['image/png', 'application/zip'],
};

function png(size: number): Buffer {
  const b = Buffer.alloc(size, 0x11);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(10, 16);
  b.writeUInt32BE(10, 20);
  return b;
}

async function putViaToken(url: string, body: Buffer): Promise<string> {
  const token = new URL(url, 'http://localhost').searchParams.get('token')!;
  const claims = verifyUploadPartToken(token)!;
  const { etag } = await receiveDiskPart(claims, Readable.from([body]));
  return etag;
}

beforeEach(async () => {
  process.env.STORAGE_SIGNING_SECRET = 'test-secret';
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'unik-storage-test-'));
  driver = new DiskObjectStorageDriver(root, buckets);
  repo = new MemoryStorageRepository();
  setObjectStorageDriverForTests(driver, null);
  setStorageRepositoryForTests(repo);
  enqueued.length = 0;
  published.length = 0;
});

afterEach(async () => {
  setObjectStorageDriverForTests(undefined, undefined);
  setStorageRepositoryForTests(null);
  await fsp.rm(root, { recursive: true, force: true });
});

describe('single-part upload', () => {
  it('goes quarantine → validating → ready and promotes to the final key', async () => {
    const data = png(2048);
    const init = await initiateUpload({
      actorId: 'u1',
      fileName: '../../evil name.png',
      declaredMimeType: 'image/png',
      declaredSize: data.length,
      target: { type: 'chat_channel', id: 'c1' },
      policy,
    });
    expect(init.multipart).toBe(false);
    expect(init.parts).toHaveLength(1);
    expect(init.object.originalName).toBe('evil name.png');
    expect(init.object.status).toBe('initiated');

    const etag = await putViaToken(init.parts![0].url, data);
    expect(etag).toMatch(/^"/);

    // Quarantined objects are never readable.
    await expect(openObjectStream(init.object)).rejects.toBeInstanceOf(StorageError);

    const completed = await completeUpload('u1', init.uploadId, [{ partNumber: 1, etag }]);
    expect(completed.status).toBe('validating');
    expect(enqueued[0]).toMatchObject({
      type: 'storage.validate_object',
      payload: { objectId: init.objectId },
    });

    const result = await validateAndPromote(init.objectId);
    expect(result.status).toBe('ready');
    const object = (await repo.getObject(init.objectId))!;
    expect(object.status).toBe('ready');
    expect(object.detectedMimeType).toBe('image/png');
    expect(object.sha256).toHaveLength(64);
    expect(fs.existsSync(driver.resolvePath('files', object.objectKey))).toBe(true);
    expect(
      fs.existsSync(
        driver.resolvePath('quarantine', `quarantine/${init.objectId}/${object.versionId}`)
      )
    ).toBe(false);
    expect(
      published.some((p) => p.channel === `upload:${init.objectId}` && p.type === 'upload.ready')
    ).toBe(true);

    const stream = await openObjectStream(object, { start: 0, end: 7 });
    expect(stream?.contentLength).toBe(8);
    const chunks: Buffer[] = [];
    for await (const c of stream!.stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).equals(data.subarray(0, 8))).toBe(true);
  });

  it('rejects a fake MIME after upload and cleans the quarantine', async () => {
    const data = Buffer.from('%PDF-1.4 not a png at all');
    const init = await initiateUpload({
      actorId: 'u1',
      fileName: 'fake.png',
      declaredMimeType: 'image/png',
      declaredSize: data.length,
      target: { type: 'chat_channel', id: 'c1' },
      policy,
    });
    const etag = await putViaToken(init.parts![0].url, data);
    await completeUpload('u1', init.uploadId, [{ partNumber: 1, etag }]);
    const result = await validateAndPromote(init.objectId);
    expect(result.status).toBe('rejected');
    const object = (await repo.getObject(init.objectId))!;
    expect(object.status).toBe('rejected');
    expect(object.rejectionReason).toMatch(/no coincide/);
    expect(published.some((p) => p.type === 'upload.rejected')).toBe(true);
    await expect(openObjectStream(object)).rejects.toBeInstanceOf(StorageError);
  });

  it('refuses declared types outside the policy and oversized declarations', async () => {
    await expect(
      initiateUpload({
        actorId: 'u1',
        fileName: 'x.exe',
        declaredMimeType: 'application/x-msdownload',
        declaredSize: 10,
        target: { type: 'chat_channel', id: 'c1' },
        policy,
      })
    ).rejects.toMatchObject({ code: 'invalid', status: 415 });
    await expect(
      initiateUpload({
        actorId: 'u1',
        fileName: 'x.png',
        declaredMimeType: 'image/png',
        declaredSize: policy.maxBytes + 1,
        target: { type: 'chat_channel', id: 'c1' },
        policy,
      })
    ).rejects.toMatchObject({ code: 'invalid', status: 413 });
  });

  it('enforces the per-user daily quota', async () => {
    settings.perUserDailyQuotaBytes = 3000;
    try {
      await initiateUpload({
        actorId: 'u1',
        fileName: 'a.png',
        declaredMimeType: 'image/png',
        declaredSize: 2000,
        target: { type: 'chat_channel', id: 'c1' },
        policy,
      });
      await expect(
        initiateUpload({
          actorId: 'u1',
          fileName: 'b.png',
          declaredMimeType: 'image/png',
          declaredSize: 2000,
          target: { type: 'chat_channel', id: 'c1' },
          policy,
        })
      ).rejects.toMatchObject({ code: 'quota' });
      // Another user is not affected.
      await initiateUpload({
        actorId: 'u2',
        fileName: 'b.png',
        declaredMimeType: 'image/png',
        declaredSize: 2000,
        target: { type: 'chat_channel', id: 'c1' },
        policy,
      });
    } finally {
      settings.perUserDailyQuotaBytes = 100 * 1024 * 1024;
    }
  });

  it('rejects a part bigger than the authorized size and a size mismatch on completion', async () => {
    const init = await initiateUpload({
      actorId: 'u1',
      fileName: 'a.png',
      declaredMimeType: 'image/png',
      declaredSize: 1000,
      target: { type: 'chat_channel', id: 'c1' },
      policy,
    });
    await expect(putViaToken(init.parts![0].url, png(1500))).rejects.toMatchObject({
      code: 'invalid',
    });
    // Short part: written but the size check fails.
    await expect(putViaToken(init.parts![0].url, png(900))).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it("does not let another user sign, complete or abort someone else's upload", async () => {
    const init = await initiateUpload({
      actorId: 'u1',
      fileName: 'a.png',
      declaredMimeType: 'image/png',
      declaredSize: 100,
      target: { type: 'chat_channel', id: 'c1' },
      policy,
    });
    await expect(signUploadParts('u2', init.uploadId, [1])).rejects.toMatchObject({ status: 404 });
    await expect(completeUpload('u2', init.uploadId, [])).rejects.toMatchObject({ status: 404 });
    await expect(abortUpload('u2', init.uploadId)).rejects.toMatchObject({ status: 404 });
  });

  it('is idempotent on repeated completion and refuses new parts after publishing', async () => {
    const data = png(512);
    const init = await initiateUpload({
      actorId: 'u1',
      fileName: 'a.png',
      declaredMimeType: 'image/png',
      declaredSize: data.length,
      target: { type: 'chat_channel', id: 'c1' },
      policy,
    });
    const etag = await putViaToken(init.parts![0].url, data);
    const first = await completeUpload('u1', init.uploadId, [{ partNumber: 1, etag }]);
    const second = await completeUpload('u1', init.uploadId, [{ partNumber: 1, etag }]);
    expect(first.status).toBe('validating');
    expect(second.status).toBe('validating');
    expect(enqueued).toHaveLength(1);
    // The upload URL is dead after completion.
    await expect(signUploadParts('u1', init.uploadId, [1])).rejects.toMatchObject({
      code: 'state',
    });
    await expect(putViaToken(init.parts![0].url, data)).rejects.toMatchObject({ code: 'state' });
  });
});

describe('multipart upload', () => {
  it('uploads parts out of order, retries a part, completes and validates', async () => {
    const data = png(12 * 1024 * 1024 + 17);
    const init = await initiateUpload({
      actorId: 'u1',
      fileName: 'big.png',
      declaredMimeType: 'image/png',
      declaredSize: data.length,
      target: { type: 'chat_channel', id: 'c1' },
      policy,
    });
    expect(init.multipart).toBe(true);
    expect(init.partCount).toBe(3);
    expect(init.parts).toBeUndefined();

    const signed = await signUploadParts('u1', init.uploadId, [3, 1, 2]);
    expect(signed.map((p) => p.partNumber).sort()).toEqual([1, 2, 3]);
    const slice = (n: number) =>
      data.subarray((n - 1) * init.partSize, Math.min(data.length, n * init.partSize));

    const etags: Record<number, string> = {};
    etags[3] = await putViaToken(signed.find((p) => p.partNumber === 3)!.url, slice(3));
    etags[1] = await putViaToken(signed.find((p) => p.partNumber === 1)!.url, slice(1));
    // Simulate an interrupted part 2 (wrong size) then a successful retry.
    await expect(
      putViaToken(signed.find((p) => p.partNumber === 2)!.url, slice(2).subarray(0, 100))
    ).rejects.toBeInstanceOf(StorageError);
    const resigned = await signUploadParts('u1', init.uploadId, [2]);
    etags[2] = await putViaToken(resigned[0].url, slice(2));

    // Completing with a missing part is a recoverable error (session stays open).
    await expect(
      completeUpload('u1', init.uploadId, [{ partNumber: 1, etag: etags[1] }])
    ).resolves.toBeDefined();
    const done = await completeUpload(
      'u1',
      init.uploadId,
      Object.entries(etags).map(([n, etag]) => ({ partNumber: Number(n), etag }))
    );
    expect(done.status).toBe('validating');
    const result = await validateAndPromote(init.objectId);
    expect(result.status).toBe('ready');
    const object = (await repo.getObject(init.objectId))!;
    expect(Number(object.sizeBytes)).toBe(data.length);
    const stat = await fsp.stat(driver.resolvePath('files', object.objectKey));
    expect(stat.size).toBe(data.length);
  });

  it('aborts an interrupted multipart upload and cleans its parts', async () => {
    const data = png(11 * 1024 * 1024);
    const init = await initiateUpload({
      actorId: 'u1',
      fileName: 'big.png',
      declaredMimeType: 'image/png',
      declaredSize: data.length,
      target: { type: 'chat_channel', id: 'c1' },
      policy,
    });
    const signed = await signUploadParts('u1', init.uploadId, [1]);
    await putViaToken(signed[0].url, data.subarray(0, init.partSize));
    await abortUpload('u1', init.uploadId);
    await abortUpload('u1', init.uploadId); // idempotent
    const object = (await repo.getObject(init.objectId))!;
    expect(object.status).toBe('aborted');
    const quarantineDir = path.join(root, 'quarantine', 'quarantine', init.objectId);
    const leftovers = fs.existsSync(quarantineDir) ? await fsp.readdir(quarantineDir) : [];
    expect(leftovers.filter((f) => f.includes('.parts-'))).toHaveLength(0);
  });
});

describe('abandoned uploads and deletion', () => {
  it('expires sessions past their TTL', async () => {
    const init = await initiateUpload({
      actorId: 'u1',
      fileName: 'a.png',
      declaredMimeType: 'image/png',
      declaredSize: 100,
      target: { type: 'chat_channel', id: 'c1' },
      policy,
    });
    const cleaned = await cleanupAbandonedUploads(new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect(cleaned).toBe(1);
    expect((await repo.getObject(init.objectId))!.status).toBe('aborted');
  });

  it('deletes the binary only when no reference remains', async () => {
    const data = png(300);
    const object = await saveGeneratedFile({
      createdBy: 'u1',
      purpose: 'ai_artifact',
      fileName: 'r.png',
      mimeType: 'image/png',
      source: { buffer: data },
    });
    expect(object.status).toBe('ready');
    repo.references.set(object.id, {
      aiAttachments: 0,
      aiArtifacts: 2,
      chatAttachments: 0,
      total: 2,
    });
    expect(await deleteObjectIfUnreferenced(object.id)).toEqual({ deleted: false, references: 2 });
    expect(fs.existsSync(driver.resolvePath('files', object.objectKey))).toBe(true);
    repo.references.set(object.id, {
      aiAttachments: 0,
      aiArtifacts: 0,
      chatAttachments: 0,
      total: 0,
    });
    expect(await deleteObjectIfUnreferenced(object.id)).toEqual({ deleted: true, references: 0 });
    expect(fs.existsSync(driver.resolvePath('files', object.objectKey))).toBe(false);
    expect(await deleteObjectIfUnreferenced(object.id)).toEqual({ deleted: true, references: 0 });
  });

  it('never removes protected objects through the generic path', async () => {
    const object = await saveGeneratedFile({
      createdBy: 'u1',
      purpose: 'document',
      fileName: 'ok.png',
      mimeType: 'image/png',
      source: { buffer: png(100) },
      retentionPolicy: 'protected',
    });
    expect(await deleteObjectIfUnreferenced(object.id)).toMatchObject({ deleted: false });
  });
});

describe('downloads', () => {
  it('uses the authenticated stream for the disk driver and for restricted content', async () => {
    const object = await saveGeneratedFile({
      createdBy: 'u1',
      purpose: 'recording',
      fileName: 'call.png',
      mimeType: 'image/png',
      source: { buffer: png(100) },
    });
    const auth = await authorizeDownload(object, { disposition: 'inline' });
    expect(auth.mode).toBe('stream');
    expect(auth.url).toBe(`/app/files/api/objects/${object.id}/content`);
  });

  it('refuses to authorize objects that are not ready', async () => {
    const init = await initiateUpload({
      actorId: 'u1',
      fileName: 'a.png',
      declaredMimeType: 'image/png',
      declaredSize: 100,
      target: { type: 'chat_channel', id: 'c1' },
      policy,
    });
    await expect(authorizeDownload(init.object, { disposition: 'inline' })).rejects.toMatchObject({
      code: 'state',
    });
  });
});

describe('saveGeneratedFile', () => {
  it('stores server-generated files from a temp path and verifies size', async () => {
    const tmp = path.join(root, 'report.csv');
    await fsp.writeFile(tmp, 'a,b\n1,2\n');
    const object = await saveGeneratedFile({
      createdBy: 'u1',
      purpose: 'ai_artifact',
      fileName: 'Reporte.csv',
      mimeType: 'text/csv',
      source: { filePath: tmp },
    });
    expect(object.status).toBe('ready');
    expect(Number(object.sizeBytes)).toBe(8);
    expect(object.objectKey).toMatch(/^assistant\//);
  });
});
