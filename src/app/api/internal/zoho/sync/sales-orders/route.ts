import { NextResponse } from 'next/server';
import { ZodError, z } from 'zod';
import { isInternalApiKeyValid } from '@/lib/internal-api-key';
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
    mode: z.enum(['scan', 'sync', 'baseline']).optional(),
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

    return NextResponse.json({
      status: 'completed',
      mode: result.mode,
      run_id: result.runId,
      pages_scanned: result.pagesScanned,
      records_seen: result.recordsSeen,
      records_pending: result.recordsPending,
      details_fetched: result.detailsFetched,
      details_failed: result.detailsFailed,
      api_calls: result.apiCalls,
    });
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
