import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import type { Readable } from 'stream';
import type { BucketAlias } from '../storage-config';
import type {
  ByteRange,
  ListObjectsResult,
  ObjectHead,
  ObjectStorageDriver,
  ObjectStreamResult,
  PutObjectInput,
  SignedGetUrl,
  SignedRequest,
} from '../object-storage';
import { assertSafeKey } from '../storage-keys';
import { createUploadPartToken } from '../upload-tokens';

/**
 * Local directory driver. Development, tests and the S3 emulator for the
 * upload contract. Multipart parts live next to the final object until
 * completion; "presigned" URLs point to the authenticated internal endpoint
 * carrying a short-lived HMAC token.
 */
export class DiskObjectStorageDriver implements ObjectStorageDriver {
  readonly provider = 'disk' as const;

  constructor(
    private readonly root: string,
    private readonly bucketNames: Record<BucketAlias, string>,
    private readonly baseUrl: string = ''
  ) {}

  private bucketDir(bucket: BucketAlias): string {
    return path.resolve(this.root, this.bucketNames[bucket]);
  }

  private objectPath(bucket: BucketAlias, key: string): string {
    assertSafeKey(key);
    const dir = this.bucketDir(bucket);
    const full = path.resolve(dir, key);
    if (!full.startsWith(dir + path.sep)) throw new Error('Invalid storage key');
    return full;
  }

  private partsDir(bucket: BucketAlias, key: string, providerUploadId: string): string {
    return `${this.objectPath(bucket, key)}.parts-${providerUploadId}`;
  }

  async putObject(input: PutObjectInput): Promise<{ etag: string | null }> {
    const full = this.objectPath(input.bucket, input.key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const hash = createHash('md5');
    if (Buffer.isBuffer(input.body)) {
      hash.update(input.body);
      await fsp.writeFile(full, input.body);
    } else {
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(full);
        (input.body as Readable)
          .on('data', (chunk: Buffer) => hash.update(chunk))
          .on('error', reject)
          .pipe(out)
          .on('finish', () => resolve())
          .on('error', reject);
      });
    }
    return { etag: `"${hash.digest('hex')}"` };
  }

  async getObjectStream(
    bucket: BucketAlias,
    key: string,
    range?: ByteRange
  ): Promise<ObjectStreamResult | null> {
    const full = this.objectPath(bucket, key);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(full);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    const totalSize = stat.size;
    const effective: ByteRange | null = range
      ? { start: range.start, end: Math.min(range.end, totalSize - 1) }
      : null;
    const stream = fs.createReadStream(
      full,
      effective ? { start: effective.start, end: effective.end } : undefined
    );
    return {
      stream,
      contentLength: effective ? effective.end - effective.start + 1 : totalSize,
      totalSize,
      contentType: null,
      range: effective,
      etag: null,
    };
  }

  async headObject(bucket: BucketAlias, key: string): Promise<ObjectHead | null> {
    try {
      const stat = await fsp.stat(this.objectPath(bucket, key));
      if (!stat.isFile()) return null;
      return { sizeBytes: stat.size, etag: null, contentType: null, lastModified: stat.mtime };
    } catch {
      return null;
    }
  }

  async deleteObject(bucket: BucketAlias, key: string): Promise<void> {
    try {
      await fsp.unlink(this.objectPath(bucket, key));
    } catch {
      // idempotent
    }
  }

  async copyObject(
    src: { bucket: BucketAlias; key: string },
    dst: { bucket: BucketAlias; key: string }
  ): Promise<void> {
    const from = this.objectPath(src.bucket, src.key);
    const to = this.objectPath(dst.bucket, dst.key);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
  }

  async listObjects(
    bucket: BucketAlias,
    prefix: string,
    cursor?: string | null,
    limit = 1000
  ): Promise<ListObjectsResult> {
    const dir = this.bucketDir(bucket);
    const all: string[] = [];
    const walk = async (current: string) => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (/\.parts-/.test(entry.name)) continue;
          await walk(full);
        } else if (entry.isFile()) {
          const rel = path.relative(dir, full).split(path.sep).join('/');
          if (rel.startsWith(prefix)) all.push(rel);
        }
      }
    };
    await walk(dir);
    all.sort();
    const startIndex = cursor ? all.findIndex((k) => k > cursor) : 0;
    const slice = startIndex < 0 ? [] : all.slice(startIndex, startIndex + limit);
    const objects = await Promise.all(
      slice.map(async (key) => {
        const stat = await fsp.stat(path.join(dir, key));
        return { key, sizeBytes: stat.size, etag: null, lastModified: stat.mtime };
      })
    );
    const last = slice[slice.length - 1];
    const hasMore = startIndex >= 0 && startIndex + limit < all.length;
    return { objects, cursor: hasMore && last ? last : null };
  }

  private signedPartUrl(
    uploadId: string,
    partNumber: number,
    contentLength: number,
    expiresInSeconds: number
  ): SignedRequest {
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const token = createUploadPartToken({
      uploadId,
      partNumber,
      contentLength,
      expiresAt: expiresAt.getTime(),
    });
    return {
      url: `${this.baseUrl}/app/files/api/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}?token=${encodeURIComponent(token)}`,
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      expiresAt,
    };
  }

  async presignPut(
    _bucket: BucketAlias,
    _key: string,
    opts: {
      expiresInSeconds: number;
      contentType: string;
      contentLength: number;
      uploadId: string;
      partNumber: number;
    }
  ): Promise<SignedRequest> {
    return this.signedPartUrl(
      opts.uploadId,
      opts.partNumber,
      opts.contentLength,
      opts.expiresInSeconds
    );
  }

  async createMultipartUpload(
    bucket: BucketAlias,
    key: string
  ): Promise<{ providerUploadId: string }> {
    const providerUploadId = `mp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await fsp.mkdir(this.partsDir(bucket, key, providerUploadId), { recursive: true });
    return { providerUploadId };
  }

  async presignUploadPart(
    _bucket: BucketAlias,
    _key: string,
    _providerUploadId: string,
    partNumber: number,
    opts: { expiresInSeconds: number; uploadId: string; contentLength: number }
  ): Promise<SignedRequest> {
    return this.signedPartUrl(opts.uploadId, partNumber, opts.contentLength, opts.expiresInSeconds);
  }

  /** Writes one part (single PUT uses part 1 with providerUploadId = null). */
  async writePart(
    bucket: BucketAlias,
    key: string,
    providerUploadId: string | null,
    partNumber: number,
    body: Readable
  ): Promise<{ etag: string; sizeBytes: number }> {
    const target = providerUploadId
      ? path.join(
          this.partsDir(bucket, key, providerUploadId),
          `part-${String(partNumber).padStart(5, '0')}`
        )
      : this.objectPath(bucket, key);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const hash = createHash('md5');
    let sizeBytes = 0;
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(target);
      body
        .on('data', (chunk: Buffer) => {
          hash.update(chunk);
          sizeBytes += chunk.length;
        })
        .on('error', reject)
        .pipe(out)
        .on('finish', () => resolve())
        .on('error', reject);
    });
    return { etag: `"${hash.digest('hex')}"`, sizeBytes };
  }

  async completeMultipartUpload(
    bucket: BucketAlias,
    key: string,
    providerUploadId: string,
    parts: Array<{ partNumber: number; etag: string }>
  ): Promise<void> {
    const dir = this.partsDir(bucket, key, providerUploadId);
    const target = this.objectPath(bucket, key);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const out = fs.createWriteStream(target);
    try {
      for (const part of sorted) {
        const partPath = path.join(dir, `part-${String(part.partNumber).padStart(5, '0')}`);
        await new Promise<void>((resolve, reject) => {
          fs.createReadStream(partPath)
            .on('error', reject)
            .on('end', () => resolve())
            .pipe(out, { end: false });
        });
      }
    } finally {
      await new Promise<void>((resolve) => out.end(() => resolve()));
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }

  async abortMultipartUpload(
    bucket: BucketAlias,
    key: string,
    providerUploadId: string
  ): Promise<void> {
    await fsp.rm(this.partsDir(bucket, key, providerUploadId), { recursive: true, force: true });
  }

  async presignGet(): Promise<SignedGetUrl | null> {
    return null;
  }

  /** Absolute path of an object (used only by legacy readers and tests). */
  resolvePath(bucket: BucketAlias, key: string): string {
    return this.objectPath(bucket, key);
  }
}
