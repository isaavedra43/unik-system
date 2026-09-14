import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getPackage } from './packages';
import { ZohoApiError } from './client';
import { canCallZohoNow, isDailyLimitError, withZohoRateBudget, SOURCE } from './zoho-sync-engine';
import { PACKAGES_ENTITY_TYPE } from './packages-sync';

/**
 * Shipment sweep: keeps the carrier of every package linked.
 *
 * Zoho stores the carrier in the package's shipment order, and creating or
 * updating that order does NOT bump the package's `last_modified_time`. The
 * regular sync only re-downloads packages whose modified time changed, so a
 * package shipped after it was first synced would keep "No enviado" and no
 * carrier forever. This sweep re-reads the DETAIL of packages that are not
 * delivered yet or have no carrier, most recent first, on a small budget per
 * run, and normalizes it immediately.
 */

export const SHIPMENT_SWEEP_REFRESH_MS = 6 * 60 * 60 * 1000;
const FINAL_STATUSES = ['delivered', 'fulfilled', 'returned', 'deleted'];

export interface ShipmentSweepResult {
  candidates: number;
  refreshed: number;
  failed: number;
  stoppedByDailyLimit: boolean;
}

/**
 * First pass: every package never re-read (backfills the carrier of the whole
 * history, recent first). Afterwards only packages that can still change
 * (not delivered / returned) are re-read, at most every 6 hours.
 */
export function buildSweepWhere(now: Date): Prisma.PackageWhereInput {
  const staleBefore = new Date(now.getTime() - SHIPMENT_SWEEP_REFRESH_MS);
  return {
    OR: [
      { lastDetailFetchedAt: null },
      {
        lastDetailFetchedAt: { lt: staleBefore },
        OR: [{ status: null }, { status: { notIn: FINAL_STATUSES, mode: 'insensitive' } }],
      },
    ],
  };
}

/** Packages without a carrier go first, then the most recent ones. */
export const SWEEP_ORDER: Prisma.PackageOrderByWithRelationInput[] = [
  { carrier: { sort: 'asc', nulls: 'first' } },
  { date: { sort: 'desc', nulls: 'last' } },
  { createdAt: 'desc' },
];

function remoteModifiedAtOf(detail: unknown, fallback: Date): Date {
  const pkg = (detail as { package?: { last_modified_time?: unknown } })?.package;
  const raw = pkg?.last_modified_time;
  if (typeof raw !== 'string') return fallback;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

interface RefreshCandidate {
  id: string;
  zohoPackageId: string;
  sourceRemoteModifiedAt: Date;
}

/** Downloads the package detail from Zoho, stores the snapshot and normalizes it now. */
async function refreshCandidate(candidate: RefreshCandidate): Promise<void> {
  const { normalizePackageSnapshot } = await import('@/modules/packages/packages-normalizer');
  const detail = await withZohoRateBudget(() => getPackage(candidate.zohoPackageId));
  const fetchedAt = new Date();
  // Never older than what we already stored, so the normalizer does not skip it.
  const remoteModifiedAt = new Date(
    Math.max(
      remoteModifiedAtOf(detail, fetchedAt).getTime(),
      candidate.sourceRemoteModifiedAt.getTime()
    )
  );
  const snapshot = await prisma.integrationSnapshot.upsert({
    where: {
      source_entityType_externalId_remoteModifiedAt: {
        source: SOURCE,
        entityType: PACKAGES_ENTITY_TYPE,
        externalId: candidate.zohoPackageId,
        remoteModifiedAt,
      },
    },
    create: {
      source: SOURCE,
      entityType: PACKAGES_ENTITY_TYPE,
      externalId: candidate.zohoPackageId,
      remoteModifiedAt,
      payload: detail as Prisma.InputJsonValue,
      fetchedAt,
      normalizationVersion: 0,
    },
    update: { payload: detail as Prisma.InputJsonValue, fetchedAt, normalizationVersion: 0 },
  });
  await normalizePackageSnapshot(snapshot);
  await prisma.package.update({
    where: { id: candidate.id },
    data: { lastDetailFetchedAt: fetchedAt },
  });
  await prisma.integrationEntityState.updateMany({
    where: {
      source: SOURCE,
      entityType: PACKAGES_ENTITY_TYPE,
      externalId: candidate.zohoPackageId,
    },
    data: { lastDetailFetchedAt: fetchedAt, needsSync: false },
  });
}

/** Undelivered packages are re-read on open after this age (delivered ones stay at 15 min). */
export const ON_DEMAND_REFRESH_MAX_AGE_MS = 3 * 60 * 1000;
const ON_DEMAND_REFRESH_FINAL_MAX_AGE_MS = 15 * 60 * 1000;

/** True when the stored row may be behind Zoho: never re-read, still changeable, or missing data. */
export function packageNeedsRefresh(
  pkg: {
    status: string | null;
    carrier: string | null;
    lastDetailFetchedAt: Date | null;
    itemCount: number;
  },
  now: Date = new Date()
): boolean {
  if (!pkg.lastDetailFetchedAt) return true;
  const age = now.getTime() - pkg.lastDetailFetchedAt.getTime();
  const final = pkg.status ? FINAL_STATUSES.includes(pkg.status.toLowerCase()) : false;
  if (age < (final ? ON_DEMAND_REFRESH_FINAL_MAX_AGE_MS : ON_DEMAND_REFRESH_MAX_AGE_MS)) return false;
  return !final || !pkg.carrier || pkg.itemCount === 0;
}

export type OnDemandRefreshResult =
  | { status: 'refreshed'; at: Date }
  | { status: 'fresh' }
  | { status: 'busy' }
  | { status: 'failed'; error: string };

/**
 * Refresh used when someone opens a package: one Zoho call, done before the
 * page renders, so the carrier, status, items and address are the ones Zoho
 * has right now. Never blocks on the rate budget (returns `busy` instead) and
 * never throws — the stored row is shown when Zoho is unavailable.
 */
export async function refreshPackageOnDemand(
  packageId: string,
  options: { force?: boolean } = {}
): Promise<OnDemandRefreshResult> {
  const pkg = await prisma.package.findUnique({
    where: { id: packageId },
    select: {
      id: true,
      zohoPackageId: true,
      sourceRemoteModifiedAt: true,
      status: true,
      carrier: true,
      lastDetailFetchedAt: true,
      _count: { select: { items: true } },
    },
  });
  if (!pkg) return { status: 'failed', error: 'Paquete no encontrado' };
  if (!options.force && !packageNeedsRefresh({ ...pkg, itemCount: pkg._count.items })) {
    return { status: 'fresh' };
  }
  if (!canCallZohoNow()) return { status: 'busy' };
  try {
    await refreshCandidate(pkg);
    return { status: 'refreshed', at: new Date() };
  } catch (error) {
    const message =
      error instanceof ZohoApiError
        ? (error.zohoMessage ?? `Zoho respondió ${error.httpStatus ?? 'con error'}`)
        : error instanceof Error && error.message.startsWith('Invalid or missing Zoho')
          ? 'Faltan credenciales de Zoho en el servidor'
          : 'No se pudo consultar Zoho';
    console.warn(
      JSON.stringify({
        event: 'zoho.packages.on_demand_refresh.failed',
        zohoPackageId: pkg.zohoPackageId,
        error: error instanceof Error ? error.message : 'unknown',
      })
    );
    return { status: 'failed', error: message };
  }
}

export async function sweepPackageShipments(options: {
  limit: number;
  now?: Date;
}): Promise<ShipmentSweepResult> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit, 200));

  const candidates = await prisma.package.findMany({
    where: buildSweepWhere(now),
    orderBy: SWEEP_ORDER,
    take: limit,
    select: { id: true, zohoPackageId: true, sourceRemoteModifiedAt: true },
  });

  let refreshed = 0;
  let failed = 0;
  let stoppedByDailyLimit = false;

  for (const candidate of candidates) {
    try {
      await refreshCandidate(candidate);
      refreshed += 1;
    } catch (error) {
      failed += 1;
      if (isDailyLimitError(error)) {
        stoppedByDailyLimit = true;
        break;
      }
      // A deleted package in Zoho (404) must not be retried every run.
      await prisma.package
        .update({ where: { id: candidate.id }, data: { lastDetailFetchedAt: new Date() } })
        .catch(() => undefined);
      console.warn(
        JSON.stringify({
          event: 'zoho.packages.shipment_sweep.failed',
          zohoPackageId: candidate.zohoPackageId,
          error: error instanceof Error ? error.message : 'unknown',
        })
      );
    }
  }

  console.info(
    JSON.stringify({
      event: 'zoho.packages.shipment_sweep.completed',
      candidates: candidates.length,
      refreshed,
      failed,
      stoppedByDailyLimit,
    })
  );

  return { candidates: candidates.length, refreshed, failed, stoppedByDailyLimit };
}
