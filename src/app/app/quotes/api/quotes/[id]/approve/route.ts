import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireQuotesApprover, quoteErrorResponse, readJson } from '../../../_shared';
import { approveQuote } from '@/modules/quotes/quotes-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireQuotesApprover();
  if ('response' in auth) return auth.response;
  try {
    const { id } = await params;
    const body = z
      .object({ expectedContentHash: z.string().min(8) })
      .parse(await readJson(request));
    const result = await approveQuote(auth.user, id, {
      expectedContentHash: body.expectedContentHash,
    });
    return NextResponse.json(result);
  } catch (err) {
    return quoteErrorResponse(err);
  }
}
