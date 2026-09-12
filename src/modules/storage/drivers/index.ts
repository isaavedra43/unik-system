import path from 'path';
import { getStorageConfig, type BucketAlias } from '../storage-config';
import type { ObjectStorageDriver } from '../object-storage';
import { DiskObjectStorageDriver } from './disk-driver';
import { R2ObjectStorageDriver } from './r2-driver';

type GlobalWithDrivers = typeof globalThis & {
  __unikStorageDriver?: ObjectStorageDriver;
  __unikBackupDriver?: ObjectStorageDriver | null;
};

/** Primary driver, created once per process from the environment. */
export function getObjectStorageDriver(): ObjectStorageDriver {
  const scope = globalThis as GlobalWithDrivers;
  if (scope.__unikStorageDriver) return scope.__unikStorageDriver;
  const config = getStorageConfig();
  const driver: ObjectStorageDriver =
    config.driver === 'r2' && config.r2
      ? new R2ObjectStorageDriver(config.r2, config.buckets)
      : new DiskObjectStorageDriver(path.resolve(process.cwd(), config.diskRoot), config.buckets);
  scope.__unikStorageDriver = driver;
  return driver;
}

/**
 * Backup driver: a SEPARATE account/bucket whose credentials the web process
 * only uses for writes/reads of backups. Null when not configured.
 */
export function getBackupDriver(): ObjectStorageDriver | null {
  const scope = globalThis as GlobalWithDrivers;
  if (scope.__unikBackupDriver !== undefined) return scope.__unikBackupDriver;
  const config = getStorageConfig();
  let driver: ObjectStorageDriver | null = null;
  if (config.backup) {
    const buckets: Record<BucketAlias, string> = {
      files: config.backup.bucket,
      recordings: config.backup.bucket,
      quarantine: config.backup.bucket,
    };
    driver = new R2ObjectStorageDriver(config.backup, buckets);
  } else if (config.driver === 'disk') {
    // Local emulation of the backup account: a sibling directory.
    const buckets: Record<BucketAlias, string> = {
      files: 'backup',
      recordings: 'backup',
      quarantine: 'backup',
    };
    driver = new DiskObjectStorageDriver(path.resolve(process.cwd(), config.diskRoot), buckets);
  }
  scope.__unikBackupDriver = driver;
  return driver;
}

/** Test helper. */
export function setObjectStorageDriverForTests(
  driver: ObjectStorageDriver | undefined,
  backup?: ObjectStorageDriver | null
): void {
  const scope = globalThis as GlobalWithDrivers;
  scope.__unikStorageDriver = driver;
  scope.__unikBackupDriver = backup;
}

/** Legacy disk reader for files still referenced by `storagePath`. */
export function getLegacyDiskDriver(): DiskObjectStorageDriver {
  const buckets: Record<BucketAlias, string> = { files: '.', recordings: '.', quarantine: '.' };
  return new DiskObjectStorageDriver(process.cwd(), buckets);
}
