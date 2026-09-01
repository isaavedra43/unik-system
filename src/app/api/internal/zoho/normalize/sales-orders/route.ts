import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isInternalApiKeyValid } from '@/lib/internal-api-key';
import {
  NormalizationAlreadyRunningError,
  NormalizePendingSnapshotsResult,
  normalizePendingSalesOrderSnapshots,
} from '@/modules/sales/sales-orders-normalizer';

export const runtime = 'nodejs';

const requestBodySchema = z
  .object({
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

function formatResult(result: NormalizePendingSnapshotsResult) {
  return {
    status: 'completed',
    ...result,
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
    const result = await normalizePendingSalesOrderSnapshots({ limit: parsedBody.data.limit });
    return NextResponse.json(formatResult(result));
  } catch (error) {
    if (error instanceof NormalizationAlreadyRunningError) {
      return NextResponse.json(
        { error: 'Normalization already running', already_running: true },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: 'Normalization failed' }, { status: 500 });
  }
}
