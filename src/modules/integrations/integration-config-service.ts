import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * Integration configuration service.
 *
 * Each integration source (e.g. "zoho") has one IntegrationConfig row whose
 * `settings` JSON bag holds runtime parameters: sync interval, timeouts,
 * max detail fetches, page limits, etc.
 *
 * The scheduler and sync workers read these values on every tick so changes
 * made from the admin UI apply immediately without a restart.
 *
 * Settings are typed per-source via a registry of default settings. Adding a
 * new integration only requires:
 *   1. Add a key to IntegrationSourceKey.
 *   2. Add a default-settings entry to DEFAULT_SETTINGS.
 *   3. Add a display name to INTEGRATION_DISPLAY_NAMES.
 */

export const INTEGRATION_SOURCE_ZOHO = 'zoho' as const;
export type IntegrationSourceKey = typeof INTEGRATION_SOURCE_ZOHO;

/** Display names shown in the admin UI. */
export const INTEGRATION_DISPLAY_NAMES: Record<IntegrationSourceKey, string> = {
  zoho: 'Zoho Inventory',
};

/**
 * Default settings per integration source. These are seeded into the DB on
 * first read and serve as the fallback when a stored setting is missing or
 * invalid.
 *
 * Each integration can extend its settings bag freely — the schema stays a
 * plain JSON column so no migration is needed to add a new knob.
 */
export interface ZohoSettings {
  /** Scheduler: minimum time between full sync runs, in ms. */
  syncIntervalMs: number;
  /** Scheduler: local DB check cadence, in ms (does NOT consume API calls). */
  checkIntervalMs: number;
  /** Scheduler: grace period before first check after boot, in ms. */
  startupDelayMs: number;
  /** Scheduler: detail downloads per scheduled run. */
  schedulerMaxDetailFetches: number;
  /** Cooldown after a FAILED sync before retrying, in ms. */
  failedRetryCooldownMs: number;
  /** Quick sync: number of recent pages to scan. */
  quickScanPages: number;
  /** Quick sync: max detail fetches per user-triggered run. */
  quickMaxDetailFetches: number;
  /** Full sync: max detail fetches per run. */
  fullMaxDetailFetches: number;
  /** Records considered "recent" if modified within this window, in ms. */
  recentThresholdMs: number;
  /** Per-page size when listing from Zoho. */
  perPage: number;
  /** Defensive upper bound on listing pages. */
  maxPages: number;
  /** Per-request Zoho timeout, in ms. */
  zohoRequestTimeoutMs: number;
  /** Per-call Prisma timeout, in ms. */
  prismaTimeoutMs: number;
  /** Wall-clock timeout for quick sync, in ms. */
  quickSyncTimeoutMs: number;
  /** Wall-clock timeout for full scan, in ms. */
  scanSyncTimeoutMs: number;
  /** Wall-clock timeout for full sync, in ms. */
  fullSyncTimeoutMs: number;
  /** RUNNING runs older than this are marked stale/FAILED, in ms. */
  staleRunThresholdMs: number;
  /** Whether the internal scheduler is enabled. */
  schedulerEnabled: boolean;
}

export type IntegrationSettings = ZohoSettings;

export const DEFAULT_SETTINGS: Record<IntegrationSourceKey, IntegrationSettings> = {
  zoho: {
    syncIntervalMs: 60 * 60 * 1000,
    checkIntervalMs: 5 * 60 * 1000,
    startupDelayMs: 30 * 1000,
    schedulerMaxDetailFetches: 100,
    failedRetryCooldownMs: 30 * 60 * 1000,
    quickScanPages: 2,
    quickMaxDetailFetches: 20,
    fullMaxDetailFetches: 50,
    recentThresholdMs: 24 * 60 * 60 * 1000,
    perPage: 200,
    maxPages: 1000,
    zohoRequestTimeoutMs: 30_000,
    prismaTimeoutMs: 30_000,
    quickSyncTimeoutMs: 3 * 60 * 1000,
    scanSyncTimeoutMs: 30 * 60 * 1000,
    fullSyncTimeoutMs: 60 * 60 * 1000,
    staleRunThresholdMs: 10 * 60 * 1000,
    schedulerEnabled: false,
  },
};

/** In-memory cache so we don't hit the DB on every single API call. */
interface CachedConfig {
  settings: IntegrationSettings;
  isEnabled: boolean;
  fetchedAt: number;
}

const cache = new Map<IntegrationSourceKey, CachedConfig>();
const CACHE_TTL_MS = 10_000;

function mergeWithDefaults(
  source: IntegrationSourceKey,
  stored: unknown
): IntegrationSettings {
  const defaults = DEFAULT_SETTINGS[source];
  if (!stored || typeof stored !== 'object') return { ...defaults };
  const s = stored as Record<string, unknown>;
  const merged = { ...defaults } as Record<string, unknown>;
  for (const key of Object.keys(defaults) as (keyof IntegrationSettings)[]) {
    const value = s[key as string];
    if (typeof value === typeof defaults[key]) {
      merged[key as string] = value;
    }
  }
  return merged as unknown as IntegrationSettings;
}

/**
 * Returns the effective settings for a source, merging stored DB values with
 * defaults. Uses a short-lived in-memory cache to avoid a DB round-trip on
 * every API call.
 */
export async function getIntegrationSettings(
  source: IntegrationSourceKey
): Promise<IntegrationSettings> {
  const cached = cache.get(source);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.settings;
  }

  let row = await prisma.integrationConfig.findUnique({ where: { source } });

  if (!row) {
    // Seed the row with defaults so the admin UI can edit it.
    row = await prisma.integrationConfig.create({
      data: {
        source,
        displayName: INTEGRATION_DISPLAY_NAMES[source],
        isEnabled: DEFAULT_SETTINGS[source].schedulerEnabled,
        settings: DEFAULT_SETTINGS[source] as unknown as Prisma.InputJsonValue,
      },
    });
  }

  const settings = mergeWithDefaults(source, row.settings);
  cache.set(source, { settings, isEnabled: row.isEnabled, fetchedAt: Date.now() });
  return settings;
}

/** Returns whether the scheduler loop should run for this source. */
export async function isIntegrationEnabled(
  source: IntegrationSourceKey
): Promise<boolean> {
  const cached = cache.get(source);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.isEnabled;
  }
  const row = await prisma.integrationConfig.findUnique({ where: { source } });
  const enabled = row?.isEnabled ?? DEFAULT_SETTINGS[source].schedulerEnabled;
  return enabled;
}

/** Invalidates the in-memory cache so the next read hits the DB. */
function invalidateIntegrationConfigCache(source?: IntegrationSourceKey): void {
  if (source) {
    cache.delete(source);
  } else {
    cache.clear();
  }
}

/** Returns all integration config rows for the admin UI. */
export async function listIntegrationConfigs() {
  // Ensure all known sources have a row.
  for (const source of Object.keys(DEFAULT_SETTINGS) as IntegrationSourceKey[]) {
    const existing = await prisma.integrationConfig.findUnique({ where: { source } });
    if (!existing) {
      await prisma.integrationConfig.create({
        data: {
          source,
          displayName: INTEGRATION_DISPLAY_NAMES[source],
          isEnabled: DEFAULT_SETTINGS[source].schedulerEnabled,
          settings: DEFAULT_SETTINGS[source] as unknown as Prisma.InputJsonValue,
        },
      });
    }
  }
  return prisma.integrationConfig.findMany({ orderBy: { source: 'asc' } });
}

/** Updates the settings bag and/or enabled flag for a source. */
export async function updateIntegrationConfig(
  source: IntegrationSourceKey,
  patch: { isEnabled?: boolean; settings?: Record<string, unknown> }
): Promise<void> {
  const current = await prisma.integrationConfig.findUnique({ where: { source } });
  if (!current) {
    throw new Error(`Integration config not found for source "${source}"`);
  }

  const currentSettings =
    current.settings && typeof current.settings === 'object'
      ? (current.settings as Record<string, unknown>)
      : {};

  const mergedSettings =
    patch.settings !== undefined
      ? mergeWithDefaults(source, { ...currentSettings, ...patch.settings })
      : mergeWithDefaults(source, current.settings);

  await prisma.integrationConfig.update({
    where: { source },
    data: {
      isEnabled: patch.isEnabled ?? current.isEnabled,
      settings: mergedSettings as unknown as Prisma.InputJsonValue,
    },
  });

  invalidateIntegrationConfigCache(source);
}
