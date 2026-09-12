import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * Storage runtime settings (quotas, retention, upload tuning).
 * Same pattern as AiConfig: one StorageConfig row with key "global", a JSON
 * bag merged with defaults and a 10s in-memory cache.
 */

const STORAGE_CONFIG_KEY = 'global' as const;

export interface StorageSettings {
  /** Size of each multipart part. R2 requires >= 5 MiB except the last part. */
  partSizeBytes: number;
  /** Files above this size use multipart. */
  multipartThresholdBytes: number;
  maxPartsPerUpload: number;
  /** Abandoned uploads are aborted after this many hours. */
  uploadSessionTtlHours: number;
  /** Validity of a signed part URL. */
  uploadUrlTtlSeconds: number;
  /** Validity of a signed download URL (5 minutes initial value). */
  signedUrlTtlSeconds: number;
  /** Bytes a single user may upload per rolling 24h window. 0 = unlimited. */
  perUserDailyQuotaBytes: number;
  /** Bytes per environment (all users) per rolling 24h window. 0 = unlimited. */
  environmentDailyQuotaBytes: number;
  maxZipExpansionBytes: number;
  maxZipRatio: number;
  maxZipEntries: number;
  /** How long `complete` waits for the validation worker before returning "validating". */
  inlineValidationWaitMs: number;
  /** Retention in days. 0 = keep. */
  recordingRetentionDays: number;
  transcriptRetentionDays: number;
  /** Generic maintenance toggle (cleanup of abandoned uploads / expired objects). */
  cleanupEnabled: boolean;
  /** Daily incremental backup toggle (requires R2_BACKUP_* variables). */
  backupEnabled: boolean;
  /** Prefer signed URLs for ordinary downloads when the driver supports them. */
  preferSignedUrls: boolean;
}

export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
  partSizeBytes: 8 * 1024 * 1024,
  multipartThresholdBytes: 8 * 1024 * 1024,
  maxPartsPerUpload: 10_000,
  uploadSessionTtlHours: 24,
  uploadUrlTtlSeconds: 15 * 60,
  signedUrlTtlSeconds: 5 * 60,
  perUserDailyQuotaBytes: 2 * 1024 * 1024 * 1024,
  environmentDailyQuotaBytes: 0,
  maxZipExpansionBytes: 512 * 1024 * 1024,
  maxZipRatio: 100,
  maxZipEntries: 10_000,
  inlineValidationWaitMs: 8000,
  recordingRetentionDays: 30,
  transcriptRetentionDays: 90,
  cleanupEnabled: true,
  backupEnabled: false,
  preferSignedUrls: true,
};

interface Cached {
  settings: StorageSettings;
  fetchedAt: number;
}

let cache: Cached | null = null;
const CACHE_TTL_MS = 10_000;

function mergeWithDefaults(stored: unknown): StorageSettings {
  const defaults = DEFAULT_STORAGE_SETTINGS;
  if (!stored || typeof stored !== 'object') return { ...defaults };
  const s = stored as Record<string, unknown>;
  const merged = { ...defaults } as Record<string, unknown>;
  for (const key of Object.keys(defaults) as (keyof StorageSettings)[]) {
    const value = s[key];
    if (value !== undefined && typeof value === typeof defaults[key]) {
      merged[key] = value;
    }
  }
  return merged as unknown as StorageSettings;
}

export async function getStorageSettings(): Promise<StorageSettings> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.settings;
  let row = await prisma.storageConfig.findUnique({ where: { key: STORAGE_CONFIG_KEY } });
  if (!row) {
    row = await prisma.storageConfig.create({
      data: {
        key: STORAGE_CONFIG_KEY,
        settings: DEFAULT_STORAGE_SETTINGS as unknown as Prisma.InputJsonValue,
      },
    });
  }
  const settings = mergeWithDefaults(row.settings);
  cache = { settings, fetchedAt: Date.now() };
  return settings;
}

export async function updateStorageSettings(
  patch: Partial<StorageSettings>
): Promise<StorageSettings> {
  const current = await getStorageSettings();
  const merged = mergeWithDefaults({ ...current, ...patch });
  await prisma.storageConfig.upsert({
    where: { key: STORAGE_CONFIG_KEY },
    create: { key: STORAGE_CONFIG_KEY, settings: merged as unknown as Prisma.InputJsonValue },
    update: { settings: merged as unknown as Prisma.InputJsonValue },
  });
  cache = null;
  return merged;
}

/** Generic key/value state (migration reports, backup checkpoints). */
export async function getStorageState<T>(key: string): Promise<T | null> {
  const row = await prisma.storageConfig.findUnique({ where: { key } });
  return (row?.settings as T) ?? null;
}

export async function setStorageState(key: string, value: unknown): Promise<void> {
  await prisma.storageConfig.upsert({
    where: { key },
    create: { key, settings: (value ?? {}) as Prisma.InputJsonValue },
    update: { settings: (value ?? {}) as Prisma.InputJsonValue },
  });
}

export function resetStorageSettingsCache(): void {
  cache = null;
}
