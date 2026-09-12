import { z } from 'zod';

/**
 * Object storage configuration (environment driven).
 *
 * Two drivers exist:
 * - `r2`   → Cloudflare R2 through the AWS SDK v3 (S3 compatible). Production.
 * - `disk` → local directory. Development, tests and reading legacy files.
 *
 * The driver is fixed at boot. If R2 is configured and fails at runtime the
 * operation errors out: UNIK never silently falls back to writing permanent
 * files on the local disk (Railway disks are ephemeral).
 *
 * Bucket aliases are logical names resolved to real bucket names per
 * environment so business code never knows a bucket name or a credential.
 */

export type StorageDriverKind = 'r2' | 'disk';
export type BucketAlias = 'files' | 'recordings' | 'quarantine';

const envSchema = z.object({
  STORAGE_DRIVER: z.enum(['r2', 'disk']).optional(),
  STORAGE_DISK_ROOT: z.string().optional(),
  STORAGE_SIGNING_SECRET: z.string().optional(),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_ENDPOINT: z.string().url().optional(),
  R2_FORCE_PATH_STYLE: z.string().optional(),
  R2_BUCKET_FILES: z.string().optional(),
  R2_BUCKET_RECORDINGS: z.string().optional(),
  R2_BUCKET_QUARANTINE: z.string().optional(),
  R2_BACKUP_ACCOUNT_ID: z.string().optional(),
  R2_BACKUP_ACCESS_KEY_ID: z.string().optional(),
  R2_BACKUP_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BACKUP_ENDPOINT: z.string().url().optional(),
  R2_BACKUP_BUCKET: z.string().optional(),
});

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  forcePathStyle: boolean;
}

export interface StorageConfig {
  driver: StorageDriverKind;
  /** Root directory for the disk driver (also used to read legacy files). */
  diskRoot: string;
  /** Real bucket name per alias (disk driver uses them as sub-directories). */
  buckets: Record<BucketAlias, string>;
  r2: R2Credentials | null;
  backup: (R2Credentials & { bucket: string }) | null;
  /** HMAC secret for disk-driver upload authorizations. */
  signingSecret: string;
}

let cached: StorageConfig | null = null;

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Loads and validates the storage configuration lazily. Only variable NAMES are
 * ever surfaced in error messages, never values.
 */
export function getStorageConfig(): StorageConfig {
  if (cached) return cached;

  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(envSchema.shape)) {
    raw[key] = emptyToUndefined(process.env[key]);
  }
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const invalid = parsed.error.issues.map((issue) => issue.path.join('.'));
    throw new Error(`Invalid storage environment variables: ${invalid.join(', ')}`);
  }
  const env = parsed.data;

  const hasR2 = Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
  const driver: StorageDriverKind = env.STORAGE_DRIVER ?? (hasR2 ? 'r2' : 'disk');

  if (driver === 'r2' && !hasR2) {
    throw new Error(
      'STORAGE_DRIVER=r2 requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY'
    );
  }

  const envSuffix = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
  const buckets: Record<BucketAlias, string> = {
    files: env.R2_BUCKET_FILES ?? `unik-files-${envSuffix}`,
    recordings: env.R2_BUCKET_RECORDINGS ?? `unik-recordings-${envSuffix}`,
    quarantine: env.R2_BUCKET_QUARANTINE ?? `unik-quarantine-${envSuffix}`,
  };

  const r2: R2Credentials | null = hasR2
    ? {
        accountId: env.R2_ACCOUNT_ID!,
        accessKeyId: env.R2_ACCESS_KEY_ID!,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
        endpoint: env.R2_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        forcePathStyle: env.R2_FORCE_PATH_STYLE === 'true',
      }
    : null;

  const hasBackup = Boolean(
    env.R2_BACKUP_ACCOUNT_ID &&
    env.R2_BACKUP_ACCESS_KEY_ID &&
    env.R2_BACKUP_SECRET_ACCESS_KEY &&
    env.R2_BACKUP_BUCKET
  );
  const backup = hasBackup
    ? {
        accountId: env.R2_BACKUP_ACCOUNT_ID!,
        accessKeyId: env.R2_BACKUP_ACCESS_KEY_ID!,
        secretAccessKey: env.R2_BACKUP_SECRET_ACCESS_KEY!,
        endpoint:
          env.R2_BACKUP_ENDPOINT ?? `https://${env.R2_BACKUP_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        forcePathStyle: env.R2_FORCE_PATH_STYLE === 'true',
        bucket: env.R2_BACKUP_BUCKET!,
      }
    : null;

  const signingSecret =
    env.STORAGE_SIGNING_SECRET ??
    emptyToUndefined(process.env.UNIK_INTERNAL_API_KEY) ??
    // Development only: a per-process secret keeps local upload URLs unguessable
    // but they stop working after a restart (which is fine for dev).
    `dev-${process.pid}-${Math.random().toString(36).slice(2)}`;

  cached = {
    driver,
    diskRoot: env.STORAGE_DISK_ROOT ?? 'data/object-storage',
    buckets,
    r2,
    backup,
    signingSecret,
  };

  if (driver === 'disk' && process.env.NODE_ENV === 'production') {
    console.warn(
      JSON.stringify({
        component: 'storage',
        level: 'warn',
        message:
          'Object storage is using the DISK driver in production. Files will not survive a redeploy. Configure R2_* variables.',
      })
    );
  }

  return cached;
}

/** Test helper: forget the cached configuration. */
export function resetStorageConfigCache(): void {
  cached = null;
}
