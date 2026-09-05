import { NextResponse } from 'next/server';
import { ZodError, z } from 'zod';
import { isInternalApiKeyValid } from '@/lib/internal-api-key';
import {
  NormalizationAlreadyRunningError,
  NormalizePendingSnapshotsResult,
  normalizePendingSalesOrderSnapshots,
} from '@/modules/sales/sales-orders-normalizer';
import {
  BaselineAlreadyCompletedError,
  BaselineResult,
  SyncAlreadyRunningError,
  SyncFailedError,
  baselineSalesOrders,
  syncSalesOrders,
} from '@/modules/integrations/zoho/sales-orders-sync';

export const runtime = 'nodejs';

const requestBodySchema = z
  .object({
    mode: z.enum(['scan', 'sync', 'quick', 'baseline']).optional(),
    max_detail_fetches: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  .refine((data) => data.mode !== 'baseline' || data.max_detail_fetches === undefined, {
    message: 'max_detail_fetches is not allowed in baseline mode',
    path: ['max_detail_fetches'],
  });

function formatBaselineResult(result: BaselineResult) {
  return {
    status: 'completed',
    mode: result.mode,
    run_id: result.runId,
    baselined: result.baselined,
  };
}

function formatSyncResult(
  result: Awaited<ReturnType<typeof syncSalesOrders>>,
  normalization: NormalizePendingSnapshotsResult | { already_running: true } | null
) {
  return {
    status: 'completed',
    mode: result.mode,
    run_id: result.runId,
    pages_scanned: result.pagesScanned,
    records_seen: result.recordsSeen,
    records_pending: result.recordsPending,
    details_fetched: result.detailsFetched,
    details_failed: result.detailsFailed,
    api_calls: result.apiCalls,
    normalization,
  };
}

export async function POST(request: Request) {
  if (!isInternalApiKeyValid(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let rawBody: unknown = {};
  try {
    const text = await request.text();
    rawBody = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const parsedBody = requestBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  try {
    if (parsedBody.data.mode === 'baseline') {
      const result = await baselineSalesOrders();
      return NextResponse.json(formatBaselineResult(result));
    }

    const result = await syncSalesOrders({
      mode: parsedBody.data.mode,
      maxDetailFetches: parsedBody.data.max_detail_fetches,
    });

    // RAW is now safe. Normalize pending snapshots synchronously so the caller
    // knows when it finished. A normalization failure is captured independently
    // and does NOT affect the already-completed RAW sync.
    let normalization: NormalizePendingSnapshotsResult | { already_running: true } | null = null;
    try {
      normalization = await normalizePendingSalesOrderSnapshots({ limit: 100 });
    } catch (error) {
      if (error instanceof NormalizationAlreadyRunningError) {
        normalization = { already_running: true };
      } else {
        // Unexpected. Log at server and keep going; the sync itself succeeded.
        console.error('Normalization failed after sync:', error);
      }
    }

    return NextResponse.json(formatSyncResult(result, normalization));
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    if (error instanceof BaselineAlreadyCompletedError) {
      return NextResponse.json({ error: 'Baseline already completed' }, { status: 409 });
    }

    if (error instanceof SyncAlreadyRunningError) {
      return NextResponse.json({ error: 'Sync already running' }, { status: 409 });
    }

    if (error instanceof SyncFailedError && error.errorCode === 'ZOHO_API_ERROR') {
      return NextResponse.json({ error: 'External service error' }, { status: 502 });
    }

    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}
