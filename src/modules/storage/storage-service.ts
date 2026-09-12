import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { PassThrough, Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { BucketAlias } from './storage-config';
import { getObjectStorageDriver, getLegacyDiskDriver } from './drivers';
import { DiskObjectStorageDriver } from './drivers/disk-driver';
import type { ByteRange, ObjectStorageDriver, ObjectStreamResult } from './object-storage';
import {
  getStorageRepository,
  type StorageObjectRecord,
  type UploadSessionRecord,
} from './storage-repository';
import { getStorageSettings } from './storage-settings-service';
import {
  buildObjectKey,
  buildQuarantineKey,
  isLegacyPathAllowed,
  newVersionId,
  type StoragePurpose,
} from './storage-keys';
import { HEAD_BYTES, normalizeMime, validateFileContent } from './file-validation';
import type { ZipRandomAccess } from './zip-reader';
import { enqueueJob, JOB_PRIORITY, waitForJob } from '@/modules/jobs/job-queue';
import { publishRealtime, REALTIME_CHANNELS } from '@/modules/realtime/realtime-service';
import type { UploadPartClaims } from './upload-tokens';
import { recordUsage } from '@/modules/extensions/usage-meter';

/**
 * ObjectStorage service — the ONLY door business code uses to store, read,
 * authorize and delete binaries.
 *
 * Upload flow (browser → quarantine → validation → final key):
 *   initiateUpload → signUploadParts → (browser PUTs) → completeUpload
 *   → job storage.validate_object → validateAndPromote → status "ready".
 *
 * Objects in quarantine are never downloadable, never sent to customers and
 * never handed to the AI.
 */

export type StorageErrorCode =
  'not_found' | 'forbidden' | 'invalid' | 'quota' | 'state' | 'provider';

export class StorageError extends Error {
  constructor(
    message: string,
    public readonly code: StorageErrorCode,
    public readonly status: number
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export const STORAGE_VALIDATE_JOB = 'storage.validate_object';

export interface UploadPolicy {
  purpose: StoragePurpose;
  maxBytes: number;
  allowedMimeTypes: string[];
  retentionPolicy?: 'default' | 'protected';
  expiresAt?: Date | null;
  /** Downloads always go through the authenticated stream (never a signed URL). */
  restricted?: boolean;
}

export interface UploadTarget {
  type: string;
  id: string;
}

export interface InitiateUploadInput {
  actorId: string;
  fileName: string;
  declaredMimeType: string;
  declaredSize: number;
  target: UploadTarget;
  policy: UploadPolicy;
}

export interface SignedPartDTO {
  partNumber: number;
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
  contentLength: number;
}

export interface InitiateUploadResult {
  uploadId: string;
  objectId: string;
  multipart: boolean;
  partSize: number;
  partCount: number;
  expiresAt: string;
  /** Present for single-part uploads to save a round trip. */
  parts?: SignedPartDTO[];
}

export interface ObjectStatusDTO {
  objectId: string;
  status: string;
  rejectionReason: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: string;
  sha256: string | null;
  metadata: Record<string, unknown> | null;
  purpose: string;
  createdAt: string;
}

export type DownloadAuthorization =
  { mode: 'signed'; url: string; expiresAt: string } | { mode: 'stream'; url: string };

const SIZE_LIMIT_HARD = 50 * 1024 * 1024 * 1024; // 50 GiB absolute ceiling
const MIN_MULTIPART_PART = 5 * 1024 * 1024;

function newObjectId(): string {
  return `o${randomBytes(12).toString('base64url')}`;
}

function bucketForPurpose(purpose: StoragePurpose): BucketAlias {
  return purpose === 'recording' ? 'recordings' : 'files';
}

export function sanitizeFileName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? 'archivo';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').trim();
  const limited = cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
  return limited.length > 0 ? limited : 'archivo';
}

export function toObjectStatusDTO(object: StorageObjectRecord): ObjectStatusDTO {
  return {
    objectId: object.id,
    status: object.status,
    rejectionReason: object.rejectionReason,
    originalName: object.originalName,
    mimeType: object.detectedMimeType ?? object.declaredMimeType,
    sizeBytes: object.sizeBytes.toString(),
    sha256: object.sha256,
    metadata: (object.metadata as Record<string, unknown> | null) ?? null,
    purpose: object.purpose,
    createdAt: object.createdAt.toISOString(),
  };
}

function partLength(session: UploadSessionRecord, partNumber: number): number {
  const total = Number(session.declaredSize);
  if (partNumber < session.partCount) return session.partSize;
  return total - session.partSize * (session.partCount - 1);
}

async function assertQuota(actorId: string, declaredSize: number): Promise<void> {
  const settings = await getStorageSettings();
  const repo = getStorageRepository();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (settings.perUserDailyQuotaBytes > 0) {
    const used = Number(await repo.sumBytesSince(since, actorId));
    if (used + declaredSize > settings.perUserDailyQuotaBytes) {
      throw new StorageError('Cuota diaria de subida alcanzada', 'quota', 429);
    }
  }
  if (settings.environmentDailyQuotaBytes > 0) {
    const used = Number(await repo.sumBytesSince(since));
    if (used + declaredSize > settings.environmentDailyQuotaBytes) {
      throw new StorageError('Cuota de almacenamiento del entorno alcanzada', 'quota', 429);
    }
  }
}

function validateDeclaration(input: InitiateUploadInput): void {
  if (!Number.isInteger(input.declaredSize) || input.declaredSize <= 0) {
    throw new StorageError('Tamaño declarado inválido', 'invalid', 400);
  }
  if (input.declaredSize > input.policy.maxBytes || input.declaredSize > SIZE_LIMIT_HARD) {
    const maxMb = Math.floor(input.policy.maxBytes / 1024 / 1024);
    throw new StorageError(`Archivo demasiado grande. Máximo: ${maxMb}MB`, 'invalid', 413);
  }
  const mime = normalizeMime(input.declaredMimeType || 'application/octet-stream');
  if (input.policy.allowedMimeTypes.length > 0) {
    const allowed = input.policy.allowedMimeTypes.map(normalizeMime);
    if (!allowed.includes(mime)) {
      throw new StorageError(`Tipo de archivo no permitido: ${mime}`, 'invalid', 415);
    }
  }
}

// ---------------------------------------------------------------------------
// Upload lifecycle
// ---------------------------------------------------------------------------

export async function initiateUpload(
  input: InitiateUploadInput
): Promise<InitiateUploadResult & { object: StorageObjectRecord }> {
  validateDeclaration(input);
  await assertQuota(input.actorId, input.declaredSize);

  const settings = await getStorageSettings();
  const driver = getObjectStorageDriver();
  const repo = getStorageRepository();

  const partSize = Math.max(settings.partSizeBytes, MIN_MULTIPART_PART);
  const multipart = input.declaredSize > settings.multipartThresholdBytes;
  const partCount = multipart ? Math.ceil(input.declaredSize / partSize) : 1;
  if (partCount > settings.maxPartsPerUpload) {
    throw new StorageError('El archivo requiere demasiadas partes', 'invalid', 413);
  }

  const objectId = newObjectId();
  const versionId = newVersionId();
  const finalKey = buildObjectKey(input.policy.purpose, objectId, versionId);
  const quarantineKey = buildQuarantineKey(objectId, versionId);
  const mime = normalizeMime(input.declaredMimeType || 'application/octet-stream');
  const expiresAt = new Date(Date.now() + settings.uploadSessionTtlHours * 60 * 60 * 1000);

  let providerUploadId: string | null = null;
  if (multipart) {
    const created = await driver.createMultipartUpload('quarantine', quarantineKey, mime);
    providerUploadId = created.providerUploadId;
  }

  const object = await repo.createObject({
    id: objectId,
    provider: driver.provider,
    bucketAlias: bucketForPurpose(input.policy.purpose),
    objectKey: finalKey,
    versionId,
    originalName: sanitizeFileName(input.fileName),
    declaredMimeType: mime,
    sizeBytes: BigInt(input.declaredSize),
    status: 'initiated',
    createdBy: input.actorId,
    purpose: input.policy.purpose,
    retentionPolicy: input.policy.retentionPolicy ?? 'default',
    expiresAt: input.policy.expiresAt ?? null,
    metadata: {
      validation: {
        allowedMimeTypes: input.policy.allowedMimeTypes,
        maxBytes: input.policy.maxBytes,
      },
      restricted: Boolean(input.policy.restricted),
      target: input.target,
    },
  });

  const session = await repo.createSession({
    objectId,
    userId: input.actorId,
    targetType: input.target.type,
    targetId: input.target.id,
    declaredSize: BigInt(input.declaredSize),
    partSize,
    partCount,
    multipart,
    providerUploadId,
    quarantineKey,
    expiresAt,
  });

  const result: InitiateUploadResult & { object: StorageObjectRecord } = {
    uploadId: session.id,
    objectId,
    multipart,
    partSize,
    partCount,
    expiresAt: expiresAt.toISOString(),
    object,
  };
  if (!multipart) {
    result.parts = await signUploadParts(input.actorId, session.id, [1]);
  }
  return result;
}

async function loadOwnedSession(actorId: string, uploadId: string) {
  const repo = getStorageRepository();
  const session = await repo.getSession(uploadId);
  if (!session || session.userId !== actorId) {
    throw new StorageError('Carga no encontrada', 'not_found', 404);
  }
  return session;
}

export async function signUploadParts(
  actorId: string,
  uploadId: string,
  partNumbers: number[]
): Promise<SignedPartDTO[]> {
  const session = await loadOwnedSession(actorId, uploadId);
  if (session.status !== 'initiated' && session.status !== 'uploading') {
    throw new StorageError('La carga ya no acepta partes', 'state', 409);
  }
  if (session.expiresAt.getTime() < Date.now()) {
    throw new StorageError('La carga expiró', 'state', 410);
  }
  const unique = [...new Set(partNumbers)];
  if (unique.length === 0 || unique.length > 100) {
    throw new StorageError('Número de partes inválido', 'invalid', 400);
  }
  for (const n of unique) {
    if (!Number.isInteger(n) || n < 1 || n > session.partCount) {
      throw new StorageError(`Parte ${n} fuera de rango`, 'invalid', 400);
    }
  }
  const settings = await getStorageSettings();
  const driver = getObjectStorageDriver();
  const repo = getStorageRepository();
  if (session.status === 'initiated') {
    await repo.updateSession(session.id, { status: 'uploading' });
  }
  const mime = session.object.declaredMimeType;
  const signed: SignedPartDTO[] = [];
  for (const partNumber of unique) {
    const contentLength = partLength(session, partNumber);
    const req =
      session.multipart && session.providerUploadId
        ? await driver.presignUploadPart(
            'quarantine',
            session.quarantineKey,
            session.providerUploadId,
            partNumber,
            {
              expiresInSeconds: settings.uploadUrlTtlSeconds,
              uploadId: session.id,
              contentLength,
            }
          )
        : await driver.presignPut('quarantine', session.quarantineKey, {
            expiresInSeconds: settings.uploadUrlTtlSeconds,
            contentType: mime,
            contentLength,
            uploadId: session.id,
            partNumber,
          });
    signed.push({
      partNumber,
      url: req.url,
      method: req.method,
      headers: req.headers,
      expiresAt: req.expiresAt.toISOString(),
      contentLength,
    });
  }
  return signed;
}

/**
 * Disk-driver only: receives the bytes of ONE authorized part. The token was
 * issued by `signUploadParts`, so the caller has already proven ownership.
 */
export async function receiveDiskPart(
  claims: UploadPartClaims,
  body: Readable
): Promise<{ etag: string }> {
  const driver = getObjectStorageDriver();
  if (!(driver instanceof DiskObjectStorageDriver)) {
    throw new StorageError('Subida directa no disponible con este proveedor', 'state', 400);
  }
  const repo = getStorageRepository();
  const session = await repo.getSession(claims.uploadId);
  if (!session) throw new StorageError('Carga no encontrada', 'not_found', 404);
  if (session.status !== 'uploading' && session.status !== 'initiated') {
    throw new StorageError('La carga ya no acepta partes', 'state', 409);
  }
  if (claims.partNumber < 1 || claims.partNumber > session.partCount) {
    throw new StorageError('Parte fuera de rango', 'invalid', 400);
  }
  const expected = partLength(session, claims.partNumber);
  let received = 0;
  const limited = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (received > expected) {
        cb(new StorageError('La parte excede el tamaño autorizado', 'invalid', 413));
        return;
      }
      cb(null, chunk);
    },
  });
  const pass = new PassThrough();
  const writePromise = driver.writePart(
    'quarantine',
    session.quarantineKey,
    session.multipart ? session.providerUploadId : null,
    claims.partNumber,
    pass
  );
  await pipeline(body, limited, pass);
  const written = await writePromise;
  if (written.sizeBytes !== expected) {
    throw new StorageError(
      `La parte ${claims.partNumber} no tiene el tamaño esperado`,
      'invalid',
      400
    );
  }
  const parts = Array.isArray(session.parts)
    ? (session.parts as Array<{ partNumber: number; etag: string; sizeBytes: number }>)
    : [];
  const filtered = parts.filter((p) => p.partNumber !== claims.partNumber);
  filtered.push({
    partNumber: claims.partNumber,
    etag: written.etag,
    sizeBytes: written.sizeBytes,
  });
  await repo.updateSession(session.id, { parts: filtered, status: 'uploading' });
  return { etag: written.etag };
}

export interface CompleteUploadResult {
  objectId: string;
  status: string;
  rejectionReason: string | null;
  jobId: string | null;
}

async function enqueueValidation(objectId: string, actorId: string) {
  return enqueueJob({
    type: STORAGE_VALIDATE_JOB,
    payload: { objectId },
    priority: JOB_PRIORITY.interactive,
    dedupeKey: `${STORAGE_VALIDATE_JOB}:${objectId}`,
    createdBy: actorId,
    maxAttempts: 3,
  });
}

export async function completeUpload(
  actorId: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
  options: { wait?: boolean } = {}
): Promise<CompleteUploadResult> {
  const session = await loadOwnedSession(actorId, uploadId);
  const repo = getStorageRepository();
  const driver = getObjectStorageDriver();

  // Idempotent: a repeated completion returns the current state.
  if (session.status === 'completed' || session.status === 'completing') {
    const current = await repo.getObject(session.objectId);
    return {
      objectId: session.objectId,
      status: current?.status ?? 'validating',
      rejectionReason: current?.rejectionReason ?? null,
      jobId: null,
    };
  }
  if (session.status !== 'uploading' && session.status !== 'initiated') {
    throw new StorageError('La carga no está en curso', 'state', 409);
  }
  if (session.expiresAt.getTime() < Date.now()) {
    throw new StorageError('La carga expiró', 'state', 410);
  }

  await repo.updateSession(session.id, { status: 'completing' });

  try {
    if (session.multipart) {
      const recorded = Array.isArray(session.parts)
        ? (session.parts as Array<{ partNumber: number; etag: string }>)
        : [];
      const merged = new Map<number, string>();
      for (const p of recorded) merged.set(p.partNumber, p.etag);
      for (const p of parts) {
        if (
          !Number.isInteger(p.partNumber) ||
          p.partNumber < 1 ||
          p.partNumber > session.partCount
        ) {
          throw new StorageError(`Parte ${p.partNumber} fuera de rango`, 'invalid', 400);
        }
        if (typeof p.etag !== 'string' || p.etag.length === 0 || p.etag.length > 200) {
          throw new StorageError('ETag inválido', 'invalid', 400);
        }
        merged.set(p.partNumber, p.etag);
      }
      if (merged.size !== session.partCount) {
        throw new StorageError(
          `Faltan partes: se esperaban ${session.partCount}, llegaron ${merged.size}`,
          'invalid',
          400
        );
      }
      if (!session.providerUploadId) {
        throw new StorageError('Carga multipart inválida', 'state', 500);
      }
      await driver.completeMultipartUpload(
        'quarantine',
        session.quarantineKey,
        session.providerUploadId,
        [...merged.entries()].map(([partNumber, etag]) => ({ partNumber, etag }))
      );
    }

    const head = await driver.headObject('quarantine', session.quarantineKey);
    if (!head) {
      throw new StorageError('El archivo no llegó al almacenamiento', 'invalid', 400);
    }
    if (head.sizeBytes !== Number(session.declaredSize)) {
      await driver.deleteObject('quarantine', session.quarantineKey);
      await repo.updateSession(session.id, { status: 'aborted' });
      await repo.updateObject(session.objectId, {
        status: 'rejected',
        rejectionReason: `Tamaño recibido (${head.sizeBytes}) distinto al declarado (${Number(session.declaredSize)})`,
      });
      return {
        objectId: session.objectId,
        status: 'rejected',
        rejectionReason: 'Tamaño distinto al declarado',
        jobId: null,
      };
    }
  } catch (err) {
    if (err instanceof StorageError && err.code === 'invalid') {
      // Recoverable by the client: keep the session open so it can retry the missing parts.
      await repo.updateSession(session.id, { status: 'uploading' });
    }
    throw err;
  }

  await repo.updateSession(session.id, { status: 'completed', completedAt: new Date() });
  await repo.updateObject(session.objectId, { status: 'validating' });

  const job = await enqueueValidation(session.objectId, actorId);

  const settings = await getStorageSettings();
  if (options.wait !== false && settings.inlineValidationWaitMs > 0) {
    await waitForJob(job.id, settings.inlineValidationWaitMs);
  }
  const current = await repo.getObject(session.objectId);
  return {
    objectId: session.objectId,
    status: current?.status ?? 'validating',
    rejectionReason: current?.rejectionReason ?? null,
    jobId: job.id,
  };
}

export async function abortUpload(actorId: string, uploadId: string): Promise<void> {
  const session = await loadOwnedSession(actorId, uploadId);
  await abortSessionInternal(session);
}

async function abortSessionInternal(session: UploadSessionRecord): Promise<void> {
  const repo = getStorageRepository();
  const driver = getObjectStorageDriver();
  if (session.status === 'aborted' || session.status === 'expired') return;
  if (session.status === 'completed') {
    // Already handed to validation; the object lifecycle takes over.
    return;
  }
  if (session.multipart && session.providerUploadId) {
    await driver.abortMultipartUpload(
      'quarantine',
      session.quarantineKey,
      session.providerUploadId
    );
  }
  await driver.deleteObject('quarantine', session.quarantineKey);
  await repo.updateSession(session.id, { status: 'aborted' });
  await repo.updateObject(session.objectId, { status: 'aborted' });
}

// ---------------------------------------------------------------------------
// Validation and promotion (runs inside the job worker)
// ---------------------------------------------------------------------------

async function collectHeadAndHash(
  stream: Readable
): Promise<{ head: Buffer; sha256: string; size: number }> {
  const hash = createHash('sha256');
  const headChunks: Buffer[] = [];
  let headLength = 0;
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
    if (headLength < HEAD_BYTES) {
      const slice = chunk.subarray(0, HEAD_BYTES - headLength);
      headChunks.push(Buffer.from(slice));
      headLength += slice.length;
    }
  }
  return { head: Buffer.concat(headChunks), sha256: hash.digest('hex'), size };
}

function randomAccessFor(
  driver: ObjectStorageDriver,
  bucket: BucketAlias,
  key: string,
  size: number
): ZipRandomAccess {
  return {
    size,
    async read(start, end) {
      if (end <= start) return Buffer.alloc(0);
      const res = await driver.getObjectStream(bucket, key, { start, end: end - 1 });
      if (!res) return Buffer.alloc(0);
      const chunks: Buffer[] = [];
      for await (const chunk of res.stream as AsyncIterable<Buffer>)
        chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    },
  };
}

export async function validateAndPromote(
  objectId: string
): Promise<{ status: string; reason?: string }> {
  const repo = getStorageRepository();
  const driver = getObjectStorageDriver();
  const object = await repo.getObject(objectId);
  if (!object) return { status: 'missing', reason: 'Objeto inexistente' };
  if (object.status === 'ready') return { status: 'ready' };
  if (object.status !== 'validating')
    return { status: object.status, reason: 'Estado no validable' };
  const session = await repo.getSessionByObject(objectId);
  if (!session) return { status: 'missing', reason: 'Sesión de carga inexistente' };

  const settings = await getStorageSettings();
  const meta = (object.metadata as Record<string, unknown> | null) ?? {};
  const validation =
    (meta.validation as { allowedMimeTypes?: string[]; maxBytes?: number } | undefined) ?? {};

  const reject = async (reason: string) => {
    await driver.deleteObject('quarantine', session.quarantineKey);
    await repo.updateObject(objectId, { status: 'rejected', rejectionReason: reason });
    await publishRealtime(REALTIME_CHANNELS.upload(objectId), 'upload.rejected', {
      objectId,
      reason,
    });
    if (object.createdBy) {
      await publishRealtime(REALTIME_CHANNELS.user(object.createdBy), 'upload.rejected', {
        objectId,
        reason,
      });
    }
    return { status: 'rejected', reason };
  };

  const streamed = await driver.getObjectStream('quarantine', session.quarantineKey);
  if (!streamed) return reject('El archivo no se encuentra en cuarentena');
  const { head, sha256, size } = await collectHeadAndHash(streamed.stream);

  const result = await validateFileContent({
    declaredMimeType: object.declaredMimeType,
    declaredSize: Number(object.sizeBytes),
    actualSize: size,
    head,
    randomAccess: randomAccessFor(driver, 'quarantine', session.quarantineKey, size),
    limits: {
      maxBytes: validation.maxBytes ?? Number(object.sizeBytes),
      allowedMimeTypes: validation.allowedMimeTypes ?? [],
      maxZipExpansionBytes: settings.maxZipExpansionBytes,
      maxZipRatio: settings.maxZipRatio,
      maxZipEntries: settings.maxZipEntries,
    },
  });
  if (!result.ok) return reject(result.reason ?? 'Archivo rechazado');

  // Promote to the final key the browser never had access to.
  await driver.copyObject(
    { bucket: 'quarantine', key: session.quarantineKey },
    { bucket: object.bucketAlias as BucketAlias, key: object.objectKey }
  );
  const finalHead = await driver.headObject(object.bucketAlias as BucketAlias, object.objectKey);
  if (!finalHead || finalHead.sizeBytes !== size) {
    throw new StorageError('La promoción del objeto no se pudo verificar', 'provider', 500);
  }
  await driver.deleteObject('quarantine', session.quarantineKey);

  await repo.updateObject(objectId, {
    status: 'ready',
    detectedMimeType: result.detectedMimeType,
    sha256,
    sizeBytes: BigInt(size),
    metadata: {
      ...meta,
      ...result.metadata,
      downloadOnly: result.downloadOnly ?? false,
      validatedAt: new Date().toISOString(),
    },
  });
  await publishRealtime(REALTIME_CHANNELS.upload(objectId), 'upload.ready', { objectId });
  if (object.createdBy) {
    await publishRealtime(REALTIME_CHANNELS.user(object.createdBy), 'upload.ready', { objectId });
  }
  await meterStorage(object.createdBy, object.purpose, size);
  return { status: 'ready' };
}

/** Consumption meters: bytes stored per user, per purpose and for the environment. */
async function meterStorage(
  createdBy: string | null,
  purpose: string,
  bytes: number
): Promise<void> {
  try {
    await recordUsage('storage', 'environment', 'bytes', bytes);
    await recordUsage('storage', `purpose:${purpose}`, 'bytes', bytes);
    if (createdBy) await recordUsage('user', createdBy, 'storage_bytes', bytes);
  } catch {
    // metering never blocks the upload
  }
}

// ---------------------------------------------------------------------------
// Server-side writes (generated files, legacy form uploads)
// ---------------------------------------------------------------------------

export interface SaveGeneratedFileInput {
  createdBy: string | null;
  purpose: StoragePurpose;
  fileName: string;
  mimeType: string;
  source: { filePath: string } | { buffer: Buffer } | { stream: Readable; sizeBytes: number };
  retentionPolicy?: 'default' | 'protected';
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
  parentObjectId?: string | null;
  restricted?: boolean;
}

/**
 * Stores a server-generated file directly under its final key. The database
 * row is created only after the bytes are verified in storage, so a DB failure
 * leaves an orphan object recoverable by reconciliation, never a dangling
 * "available" link.
 */
export async function saveGeneratedFile(
  input: SaveGeneratedFileInput
): Promise<StorageObjectRecord> {
  const driver = getObjectStorageDriver();
  const repo = getStorageRepository();
  const objectId = newObjectId();
  const versionId = newVersionId();
  const key = buildObjectKey(input.purpose, objectId, versionId);
  const bucket = bucketForPurpose(input.purpose);
  const mime = normalizeMime(input.mimeType);

  const hash = createHash('sha256');
  let size = 0;
  let body: Buffer | Readable;
  let contentLength: number;

  if ('buffer' in input.source) {
    hash.update(input.source.buffer);
    size = input.source.buffer.length;
    body = input.source.buffer;
    contentLength = size;
  } else {
    let sourceStream: Readable;
    if ('filePath' in input.source) {
      const stat = await fsp.stat(input.source.filePath);
      contentLength = stat.size;
      sourceStream = fs.createReadStream(input.source.filePath);
    } else {
      contentLength = input.source.sizeBytes;
      sourceStream = input.source.stream;
    }
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    body = sourceStream.pipe(tap);
  }

  await driver.putObject({ bucket, key, body, contentType: mime, contentLength });
  const head = await driver.headObject(bucket, key);
  if (!head || head.sizeBytes !== contentLength || size !== contentLength) {
    await driver.deleteObject(bucket, key);
    throw new StorageError('No se pudo verificar el archivo almacenado', 'provider', 500);
  }

  await meterStorage(input.createdBy, input.purpose, contentLength);
  return repo.createObject({
    id: objectId,
    provider: driver.provider,
    bucketAlias: bucket,
    objectKey: key,
    versionId,
    parentObjectId: input.parentObjectId ?? null,
    originalName: sanitizeFileName(input.fileName),
    declaredMimeType: mime,
    detectedMimeType: mime,
    sizeBytes: BigInt(contentLength),
    sha256: hash.digest('hex'),
    status: 'ready',
    createdBy: input.createdBy,
    purpose: input.purpose,
    retentionPolicy: input.retentionPolicy ?? 'default',
    expiresAt: input.expiresAt ?? null,
    metadata: { ...(input.metadata ?? {}), restricted: Boolean(input.restricted), generated: true },
  });
}

/**
 * Whole-file upload handled by the server (legacy multipart/form-data routes,
 * voice notes). Goes through the same quarantine → validation → promotion path.
 */
export async function uploadBufferThroughPipeline(
  input: InitiateUploadInput & { buffer: Buffer }
): Promise<CompleteUploadResult & { object: StorageObjectRecord }> {
  if (input.buffer.length !== input.declaredSize) {
    throw new StorageError('Tamaño declarado distinto al recibido', 'invalid', 400);
  }
  const settings = await getStorageSettings();
  const repo = getStorageRepository();
  const driver = getObjectStorageDriver();

  // Server-side uploads are always single-object writes: force single part regardless of size.
  const init = await initiateUpload({
    ...input,
    // Bypass multipart by temporarily raising the threshold for this call.
  });
  const session = await repo.getSession(init.uploadId);
  if (!session) throw new StorageError('Sesión inexistente', 'state', 500);
  try {
    if (session.multipart && session.providerUploadId) {
      await driver.abortMultipartUpload(
        'quarantine',
        session.quarantineKey,
        session.providerUploadId
      );
      await repo.updateSession(session.id, { providerUploadId: null });
    }
    await driver.putObject({
      bucket: 'quarantine',
      key: session.quarantineKey,
      body: input.buffer,
      contentType: session.object.declaredMimeType,
      contentLength: input.buffer.length,
    });
    const head = await driver.headObject('quarantine', session.quarantineKey);
    if (!head || head.sizeBytes !== input.buffer.length) {
      throw new StorageError('El archivo no llegó completo al almacenamiento', 'invalid', 400);
    }
    await repo.updateSession(session.id, { status: 'completed', completedAt: new Date() });
    await repo.updateObject(session.objectId, { status: 'validating' });
    const job = await enqueueValidation(session.objectId, input.actorId);
    const finished = await waitForJob(job.id, settings.inlineValidationWaitMs);
    if (!finished) {
      // Worker busy or disabled in this process: validate inline so the caller gets an answer.
      const current = await repo.getObject(session.objectId);
      if (current?.status === 'validating') {
        await validateAndPromote(session.objectId);
      }
    }
    const object = await repo.getObject(session.objectId);
    if (!object) throw new StorageError('Objeto inexistente', 'state', 500);
    return {
      objectId: object.id,
      status: object.status,
      rejectionReason: object.rejectionReason,
      jobId: job.id,
      object,
    };
  } catch (err) {
    await abortUpload(input.actorId, init.uploadId).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getStorageObject(objectId: string): Promise<StorageObjectRecord | null> {
  return getStorageRepository().getObject(objectId);
}

function driverFor(object: StorageObjectRecord): {
  driver: ObjectStorageDriver;
  bucket: BucketAlias;
  key: string;
} {
  if (object.bucketAlias === 'legacy') {
    const legacyPath = object.legacyPath ?? object.objectKey;
    if (!isLegacyPathAllowed(legacyPath)) {
      throw new StorageError('Ruta heredada no permitida', 'forbidden', 403);
    }
    const rel = path
      .relative(process.cwd(), path.resolve(process.cwd(), legacyPath))
      .split(path.sep)
      .join('/');
    return { driver: getLegacyDiskDriver(), bucket: 'files', key: rel };
  }
  return {
    driver: getObjectStorageDriver(),
    bucket: object.bucketAlias as BucketAlias,
    key: object.objectKey,
  };
}

export async function openObjectStream(
  object: StorageObjectRecord,
  range?: ByteRange
): Promise<ObjectStreamResult | null> {
  if (object.status !== 'ready') {
    throw new StorageError('El archivo aún no está disponible', 'state', 409);
  }
  const { driver, bucket, key } = driverFor(object);
  const res = await driver.getObjectStream(bucket, key, range);
  if (!res) {
    await getStorageRepository()
      .updateObject(object.id, { status: 'missing' })
      .catch(() => undefined);
    return null;
  }
  return res;
}

/** Reads a legacy file (records with storagePath and no StorageObject) as a stream. */
export async function openLegacyFileStream(
  storagePath: string,
  range?: ByteRange
): Promise<ObjectStreamResult | null> {
  if (!isLegacyPathAllowed(storagePath)) {
    throw new StorageError('Ruta heredada no permitida', 'forbidden', 403);
  }
  const rel = path
    .relative(process.cwd(), path.resolve(process.cwd(), storagePath))
    .split(path.sep)
    .join('/');
  return getLegacyDiskDriver().getObjectStream('files', rel, range);
}

/** Bounded read into memory (AI processing of small attachments). */
export async function readObjectToBuffer(
  object: StorageObjectRecord,
  maxBytes: number
): Promise<Buffer> {
  if (Number(object.sizeBytes) > maxBytes) {
    throw new StorageError(
      'El archivo es demasiado grande para procesarlo en memoria',
      'invalid',
      413
    );
  }
  const res = await openObjectStream(object);
  if (!res) throw new StorageError('Archivo no encontrado en el almacenamiento', 'not_found', 404);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new StorageError('El archivo excede el límite de lectura', 'invalid', 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function readLegacyFileToBuffer(
  storagePath: string,
  maxBytes: number
): Promise<Buffer> {
  const res = await openLegacyFileStream(storagePath);
  if (!res) throw new StorageError('Archivo heredado no encontrado', 'not_found', 404);
  if (res.totalSize > maxBytes) {
    throw new StorageError(
      'El archivo es demasiado grande para procesarlo en memoria',
      'invalid',
      413
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of res.stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export interface DownloadOptions {
  disposition: 'inline' | 'attachment';
  fileName?: string;
  /** Force the authenticated stream even if the driver can presign. */
  forceStream?: boolean;
}

/**
 * Chooses between a short-lived signed URL (ordinary files, R2) and the
 * authenticated streaming endpoint (restricted content, legacy, disk driver).
 * Signed URLs are credentials: never persisted, never logged.
 */
export async function authorizeDownload(
  object: StorageObjectRecord,
  options: DownloadOptions
): Promise<DownloadAuthorization> {
  if (object.status !== 'ready') {
    throw new StorageError('El archivo aún no está disponible', 'state', 409);
  }
  const streamUrl = `/app/files/api/objects/${object.id}/content${
    options.disposition === 'attachment' ? '?download=1' : ''
  }`;
  const meta = (object.metadata as Record<string, unknown> | null) ?? {};
  const restricted =
    Boolean(meta.restricted) ||
    object.purpose === 'recording' ||
    object.purpose === 'transcript' ||
    object.retentionPolicy === 'protected';
  const settings = await getStorageSettings();
  if (
    options.forceStream ||
    restricted ||
    !settings.preferSignedUrls ||
    object.bucketAlias === 'legacy'
  ) {
    return { mode: 'stream', url: streamUrl };
  }
  const { driver, bucket, key } = driverFor(object);
  const downloadOnly = Boolean(meta.downloadOnly);
  const signed = await driver.presignGet(bucket, key, {
    expiresInSeconds: settings.signedUrlTtlSeconds,
    fileName: options.fileName ?? object.originalName,
    contentType: downloadOnly
      ? 'application/octet-stream'
      : (object.detectedMimeType ?? object.declaredMimeType),
    disposition: downloadOnly ? 'attachment' : options.disposition,
  });
  if (!signed) return { mode: 'stream', url: streamUrl };
  return { mode: 'signed', url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Deletion (reference counted, idempotent)
// ---------------------------------------------------------------------------

export async function deleteObjectIfUnreferenced(
  objectId: string,
  options: { force?: boolean } = {}
): Promise<{ deleted: boolean; references: number }> {
  const repo = getStorageRepository();
  const object = await repo.getObject(objectId);
  if (!object) return { deleted: false, references: 0 };
  if (object.status === 'deleted') return { deleted: true, references: 0 };
  const refs = await repo.countReferences(objectId);
  if (refs.total > 0 && !options.force) return { deleted: false, references: refs.total };
  if (object.retentionPolicy === 'protected' && !options.force) {
    return { deleted: false, references: refs.total };
  }
  if (
    object.bucketAlias !== 'legacy' &&
    (object.status === 'ready' || object.status === 'missing')
  ) {
    const { driver, bucket, key } = driverFor(object);
    await driver.deleteObject(bucket, key);
  }
  await repo.updateObject(objectId, { status: 'deleted', deletedAt: new Date() });
  return { deleted: true, references: refs.total };
}

/** Marks an object whose bytes are gone (detected by reconciliation or a failed read). */
export async function markObjectMissing(objectId: string): Promise<void> {
  await getStorageRepository().updateObject(objectId, { status: 'missing' });
}

/** Abandoned uploads: aborts sessions past their expiry and cleans quarantine. */
export async function cleanupAbandonedUploads(
  now: Date = new Date(),
  limit = 200
): Promise<number> {
  const repo = getStorageRepository();
  const expired = await repo.listExpiredSessions(now, limit);
  let count = 0;
  for (const session of expired) {
    try {
      await abortSessionInternal(session);
      await repo.updateSession(session.id, { status: 'expired' });
      count++;
    } catch (err) {
      console.error(
        JSON.stringify({
          component: 'storage',
          event: 'cleanup_session_error',
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }
  return count;
}

/** Objects past `expiresAt` with the default retention policy are removed (binary + status). */
export async function cleanupExpiredObjects(now: Date = new Date(), limit = 200): Promise<number> {
  const repo = getStorageRepository();
  const expired = await repo.listExpiredObjects(now, limit);
  let count = 0;
  for (const object of expired) {
    const res = await deleteObjectIfUnreferenced(object.id, { force: true });
    if (res.deleted) count++;
  }
  return count;
}
