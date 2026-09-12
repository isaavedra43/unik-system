import type { Readable } from 'stream';
import type { BucketAlias } from './storage-config';

/**
 * Provider-agnostic object storage driver.
 *
 * Business services never build URLs nor see bucket names or credentials:
 * they talk to `StorageService`, which talks to one of these drivers.
 */

export interface ByteRange {
  start: number;
  /** Inclusive end. */
  end: number;
}

export interface ObjectHead {
  sizeBytes: number;
  etag: string | null;
  contentType: string | null;
  lastModified: Date | null;
}

export interface ObjectStreamResult {
  stream: Readable;
  contentLength: number;
  /** Total object size (for Range responses). */
  totalSize: number;
  contentType: string | null;
  range: ByteRange | null;
  etag: string | null;
}

export interface SignedRequest {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface SignedGetUrl {
  url: string;
  expiresAt: Date;
}

export interface ListedObject {
  key: string;
  sizeBytes: number;
  etag: string | null;
  lastModified: Date | null;
}

export interface ListObjectsResult {
  objects: ListedObject[];
  cursor: string | null;
}

export interface PutObjectInput {
  bucket: BucketAlias;
  key: string;
  body: Buffer | Readable;
  contentType: string;
  contentLength?: number;
}

export interface ObjectStorageDriver {
  readonly provider: 'r2' | 'disk';

  putObject(input: PutObjectInput): Promise<{ etag: string | null }>;
  getObjectStream(
    bucket: BucketAlias,
    key: string,
    range?: ByteRange
  ): Promise<ObjectStreamResult | null>;
  headObject(bucket: BucketAlias, key: string): Promise<ObjectHead | null>;
  deleteObject(bucket: BucketAlias, key: string): Promise<void>;
  copyObject(
    src: { bucket: BucketAlias; key: string },
    dst: { bucket: BucketAlias; key: string }
  ): Promise<void>;
  listObjects(
    bucket: BucketAlias,
    prefix: string,
    cursor?: string | null,
    limit?: number
  ): Promise<ListObjectsResult>;

  /** Single-request upload authorization (files up to one part). */
  presignPut(
    bucket: BucketAlias,
    key: string,
    opts: {
      expiresInSeconds: number;
      contentType: string;
      contentLength: number;
      uploadId: string;
      partNumber: number;
    }
  ): Promise<SignedRequest>;

  createMultipartUpload(
    bucket: BucketAlias,
    key: string,
    contentType: string
  ): Promise<{ providerUploadId: string }>;
  presignUploadPart(
    bucket: BucketAlias,
    key: string,
    providerUploadId: string,
    partNumber: number,
    opts: { expiresInSeconds: number; uploadId: string; contentLength: number }
  ): Promise<SignedRequest>;
  completeMultipartUpload(
    bucket: BucketAlias,
    key: string,
    providerUploadId: string,
    parts: Array<{ partNumber: number; etag: string }>
  ): Promise<void>;
  abortMultipartUpload(bucket: BucketAlias, key: string, providerUploadId: string): Promise<void>;

  /** Short-lived download URL. Returns null when the driver cannot presign (disk). */
  presignGet(
    bucket: BucketAlias,
    key: string,
    opts: {
      expiresInSeconds: number;
      fileName: string;
      contentType: string;
      disposition: 'inline' | 'attachment';
    }
  ): Promise<SignedGetUrl | null>;
}

export function rangeLength(range: ByteRange): number {
  return range.end - range.start + 1;
}

/** Parses an HTTP Range header (single range only). Returns null when absent/invalid. */
export function parseRangeHeader(
  header: string | null,
  totalSize: number
): ByteRange | null | 'unsatisfiable' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startStr, endStr] = match;
  if (startStr === '' && endStr === '') return null;
  let start: number;
  let end: number;
  if (startStr === '') {
    // suffix range: last N bytes
    const suffix = parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? totalSize - 1 : parseInt(endStr, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= totalSize || start < 0) return 'unsatisfiable';
  if (end >= totalSize) end = totalSize - 1;
  if (end < start) return 'unsatisfiable';
  return { start, end };
}
