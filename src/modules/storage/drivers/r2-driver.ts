import type { Readable } from 'stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BucketAlias, R2Credentials } from '../storage-config';
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

/**
 * Cloudflare R2 driver (S3-compatible API, AWS SDK v3).
 *
 * Region is always `auto`. Checksum calculation is set to WHEN_REQUIRED
 * because R2 does not accept the default CRC32 trailers newer SDKs send.
 * Objects and metadata are encrypted at rest by R2; UNIK adds nothing here —
 * authorization always happens in the application layer.
 */
export class R2ObjectStorageDriver implements ObjectStorageDriver {
  readonly provider = 'r2' as const;
  private readonly client: S3Client;

  constructor(
    credentials: R2Credentials,
    private readonly bucketNames: Record<BucketAlias, string>
  ) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: credentials.endpoint,
      forcePathStyle: credentials.forcePathStyle,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  private bucket(alias: BucketAlias): string {
    return this.bucketNames[alias];
  }

  async putObject(input: PutObjectInput): Promise<{ etag: string | null }> {
    assertSafeKey(input.key);
    const res = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket(input.bucket),
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
      })
    );
    return { etag: res.ETag ?? null };
  }

  async getObjectStream(
    bucket: BucketAlias,
    key: string,
    range?: ByteRange
  ): Promise<ObjectStreamResult | null> {
    assertSafeKey(key);
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket(bucket),
          Key: key,
          Range: range ? `bytes=${range.start}-${range.end}` : undefined,
        })
      );
      if (!res.Body) return null;
      const contentLength = Number(res.ContentLength ?? 0);
      let totalSize = contentLength;
      let effectiveRange: ByteRange | null = null;
      if (res.ContentRange) {
        const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(res.ContentRange);
        if (m) {
          effectiveRange = { start: Number(m[1]), end: Number(m[2]) };
          totalSize = Number(m[3]);
        }
      }
      return {
        stream: res.Body as Readable,
        contentLength,
        totalSize,
        contentType: res.ContentType ?? null,
        range: effectiveRange,
        etag: res.ETag ?? null,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async headObject(bucket: BucketAlias, key: string): Promise<ObjectHead | null> {
    assertSafeKey(key);
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket(bucket), Key: key })
      );
      return {
        sizeBytes: Number(res.ContentLength ?? 0),
        etag: res.ETag ?? null,
        contentType: res.ContentType ?? null,
        lastModified: res.LastModified ?? null,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async deleteObject(bucket: BucketAlias, key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket(bucket), Key: key }));
  }

  async copyObject(
    src: { bucket: BucketAlias; key: string },
    dst: { bucket: BucketAlias; key: string }
  ): Promise<void> {
    assertSafeKey(src.key);
    assertSafeKey(dst.key);
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket(dst.bucket),
        Key: dst.key,
        CopySource: `/${this.bucket(src.bucket)}/${src.key}`,
      })
    );
  }

  async listObjects(
    bucket: BucketAlias,
    prefix: string,
    cursor?: string | null,
    limit = 1000
  ): Promise<ListObjectsResult> {
    const res = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket(bucket),
        Prefix: prefix,
        ContinuationToken: cursor ?? undefined,
        MaxKeys: Math.min(limit, 1000),
      })
    );
    return {
      objects: (res.Contents ?? [])
        .filter((o) => typeof o.Key === 'string')
        .map((o) => ({
          key: o.Key as string,
          sizeBytes: Number(o.Size ?? 0),
          etag: o.ETag ?? null,
          lastModified: o.LastModified ?? null,
        })),
      cursor: res.IsTruncated ? (res.NextContinuationToken ?? null) : null,
    };
  }

  async presignPut(
    bucket: BucketAlias,
    key: string,
    opts: { expiresInSeconds: number; contentType: string; contentLength: number }
  ): Promise<SignedRequest> {
    assertSafeKey(key);
    const command = new PutObjectCommand({
      Bucket: this.bucket(bucket),
      Key: key,
      ContentType: opts.contentType,
      ContentLength: opts.contentLength,
    });
    const url = await getSignedUrl(this.client, command, { expiresIn: opts.expiresInSeconds });
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': opts.contentType },
      expiresAt: new Date(Date.now() + opts.expiresInSeconds * 1000),
    };
  }

  async createMultipartUpload(
    bucket: BucketAlias,
    key: string,
    contentType: string
  ): Promise<{ providerUploadId: string }> {
    assertSafeKey(key);
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket(bucket),
        Key: key,
        ContentType: contentType,
      })
    );
    if (!res.UploadId) throw new Error('R2 did not return an UploadId');
    return { providerUploadId: res.UploadId };
  }

  async presignUploadPart(
    bucket: BucketAlias,
    key: string,
    providerUploadId: string,
    partNumber: number,
    opts: { expiresInSeconds: number; contentLength: number }
  ): Promise<SignedRequest> {
    assertSafeKey(key);
    const command = new UploadPartCommand({
      Bucket: this.bucket(bucket),
      Key: key,
      UploadId: providerUploadId,
      PartNumber: partNumber,
      ContentLength: opts.contentLength,
    });
    const url = await getSignedUrl(this.client, command, { expiresIn: opts.expiresInSeconds });
    return {
      url,
      method: 'PUT',
      headers: {},
      expiresAt: new Date(Date.now() + opts.expiresInSeconds * 1000),
    };
  }

  async completeMultipartUpload(
    bucket: BucketAlias,
    key: string,
    providerUploadId: string,
    parts: Array<{ partNumber: number; etag: string }>
  ): Promise<void> {
    assertSafeKey(key);
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket(bucket),
        Key: key,
        UploadId: providerUploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      })
    );
  }

  async abortMultipartUpload(
    bucket: BucketAlias,
    key: string,
    providerUploadId: string
  ): Promise<void> {
    assertSafeKey(key);
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket(bucket),
          Key: key,
          UploadId: providerUploadId,
        })
      );
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async presignGet(
    bucket: BucketAlias,
    key: string,
    opts: {
      expiresInSeconds: number;
      fileName: string;
      contentType: string;
      disposition: 'inline' | 'attachment';
    }
  ): Promise<SignedGetUrl | null> {
    assertSafeKey(key);
    const safeName = opts.fileName.replace(/["\\\r\n]/g, '_');
    const command = new GetObjectCommand({
      Bucket: this.bucket(bucket),
      Key: key,
      ResponseContentType: opts.contentType,
      ResponseContentDisposition: `${opts.disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(opts.fileName)}`,
    });
    const url = await getSignedUrl(this.client, command, { expiresIn: opts.expiresInSeconds });
    return { url, expiresAt: new Date(Date.now() + opts.expiresInSeconds * 1000) };
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'NoSuchKey' ||
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchUpload' ||
    e?.$metadata?.httpStatusCode === 404
  );
}
