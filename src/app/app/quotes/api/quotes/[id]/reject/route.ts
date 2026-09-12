import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireQuotesApprover, quoteErrorResponse, readJson } from '../../../_shared';
import { rejectQuote } from '@/modules/quotes/quotes-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireQuotesApprover();
  if ('response' in auth) return auth.response;
  try {
    const { id } = await params;
    const body = z
      .object({ reason: z.string().max(500).optional() })
      .parse(await readJson(request));
    return NextResponse.json({ quote: await rejectQuote(auth.user, id, body.reason) });
  } catch (err) {
    return quoteErrorResponse(err);
  }
}
