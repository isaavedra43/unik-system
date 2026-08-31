import { NextResponse } from 'next/server';
import { ZodError, z } from 'zod';
import { isInternalApiKeyValid } from '@/lib/internal-api-key';
import {
  SyncAlreadyRunningError,
  SyncFailedError,
  syncSalesOrders,
} from '@/modules/integrations/zoho/sales-orders-sync';

export const runtime = 'nodejs';

const requestBodySchema = z
  .object({
    mode: z.enum(['scan', 'sync']).optional(),
    max_detail_fetches: z.number().optional(),
  })
  .strict();

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
    // maxDetailFetches out of range or an unusable mode reaches us as a ZodError.
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
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
