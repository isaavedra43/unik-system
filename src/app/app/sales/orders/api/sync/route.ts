import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  SyncAlreadyRunningError,
  syncSalesOrders,
} from '@/modules/integrations/zoho/sales-orders-sync';
import { prisma } from '@/lib/prisma';
import {
  NormalizationAlreadyRunningError,
  NormalizePendingSnapshotsResult,
  normalizePendingSalesOrderSnapshots,
} from '@/modules/sales/sales-orders-normalizer';

export const runtime = 'nodejs';

/**
 * Manual Sales Orders sync endpoint.
 *
 * Pipeline (must match the existing architecture):
 *   syncSalesOrders({ mode: 'sync' })   -> IntegrationSnapshot (RAW)
 *   normalizePendingSalesOrderSnapshots() -> SalesOrder / SalesOrderItem
 *
 * Reuses the existing `syncSalesOrders` from `@/modules/integrations/zoho` —
 * the same function the internal scheduler invokes. The manual run goes
 * through the in-memory sync lock, so a concurrent scheduled or manual run
 * surfaces as 409 instead of racing.
 *
 * Normalization is awaited BEFORE the endpoint responds, so the client only
 * sees success once the persisted `SalesOrder` rows reflect the Zoho state.
 *
 * Permission is permission-aware (must hold `sales_orders.view`).
 */

const MANUAL_MAX_DETAIL_FETCHES = 200;
const NORMALIZATION_BATCH_LIMIT = 500;
const NORMALIZATION_LOCK_RETRY_MS = 500;
const NORMALIZATION_LOCK_RETRIES = 10;

interface ManualSyncResponse {
  runId: string;
  mode: 'sync';
  completedAt: string | null;
  pagesScanned: number;
  recordsSeen: number;
  recordsPending: number;
  detailsFetched: number;
  detailsFailed: number;
  apiCalls: number;
  normalized: number;
  skipped: number;
  normalizationSeen: number;
  normalizationFailed: number;
}

export async function POST(): Promise<NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (
    !session.user.isSuperAdmin &&
    !session.user.permissionKeys.includes('sales_orders.view')
  ) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  // ----- 1. RAW sync (mode: 'sync' so details are fetched and snapshots are persisted) -----
  let sync;
  try {
    sync = await syncSalesOrders({
      mode: 'sync',
      maxDetailFetches: MANUAL_MAX_DETAIL_FETCHES,
    });
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError) {
      return NextResponse.json(
        { error: 'Ya hay una sincronización en curso' },
        { status: 409 }
      );
    }
    console.error('sales orders sync error', error);
    return NextResponse.json(
      { error: 'No se pudo sincronizar con Zoho' },
      { status: 500 }
    );
  }

  // The persisted IntegrationSyncRun row now holds the real completedAt
  // timestamp. We re-fetch it so the client gets the authoritative value.
  const run = await prisma.integrationSyncRun.findUnique({
    where: { id: sync.runId },
    select: { completedAt: true },
  });
  const completedAt = run?.completedAt ? run.completedAt.toISOString() : null;

  // ----- 2. Drain pending snapshots through the existing normalizer -----
  let totalNormalized = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let totalSeen = 0;
  let normalizationAborted = false;

  for (let attempt = 0; attempt <= NORMALIZATION_LOCK_RETRIES; attempt += 1) {
    let batch: NormalizePendingSnapshotsResult | null = null;
    try {
      batch = await normalizePendingSalesOrderSnapshots({
        limit: NORMALIZATION_BATCH_LIMIT,
      });
    } catch (error) {
      if (error instanceof NormalizationAlreadyRunningError) {
        // Another process (e.g. scheduler) holds the normalizer lock. Wait
        // briefly and retry so we still drain the queue.
        await new Promise((resolve) => setTimeout(resolve, NORMALIZATION_LOCK_RETRY_MS));
        continue;
      }
      console.error('normalization failed after sync', error);
      normalizationAborted = true;
      break;
    }

    totalSeen += batch.seen;
    totalNormalized += batch.normalized;
    totalSkipped += batch.skipped;
    totalFailed += batch.failed;

    if (batch.seen < NORMALIZATION_BATCH_LIMIT) {
      break;
    }
  }

  if (totalSeen === NORMALIZATION_BATCH_LIMIT * (NORMALIZATION_LOCK_RETRIES + 1)) {
    normalizationAborted = true;
  }

  // Only declare success once the sync run completed AND the normalization
  // pipeline finished without aborting. The client must never see a
  // "successful" timestamp if SalesOrder rows weren't actually persisted.
  if (normalizationAborted) {
    return NextResponse.json(
      {
        error:
          'La sincronización con Zoho terminó, pero la normalización no pudo completarse. Inténtalo de nuevo.',
        runId: sync.runId,
        mode: 'sync',
        completedAt,
        pagesScanned: sync.pagesScanned,
        recordsSeen: sync.recordsSeen,
        recordsPending: sync.recordsPending,
        detailsFetched: sync.detailsFetched,
        detailsFailed: sync.detailsFailed,
        apiCalls: sync.apiCalls,
        normalized: totalNormalized,
        skipped: totalSkipped,
        normalizationSeen: totalSeen,
        normalizationFailed: totalFailed + 1,
      },
      { status: 500 }
    );
  }

  const body: ManualSyncResponse = {
    runId: sync.runId,
    mode: 'sync',
    completedAt,
    pagesScanned: sync.pagesScanned,
    recordsSeen: sync.recordsSeen,
    recordsPending: sync.recordsPending,
    detailsFetched: sync.detailsFetched,
    detailsFailed: sync.detailsFailed,
    apiCalls: sync.apiCalls,
    normalized: totalNormalized,
    skipped: totalSkipped,
    normalizationSeen: totalSeen,
    normalizationFailed: totalFailed,
  };

  return NextResponse.json(body);
}
