import { NextRequest, NextResponse } from 'next/server';
import { requireQuotesUser, quoteErrorResponse, readJson } from '../../_shared';
import { getQuote, updateQuote } from '@/modules/quotes/quotes-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireQuotesUser();
  if ('response' in auth) return auth.response;
  try {
    const { id } = await params;
    return NextResponse.json({ quote: await getQuote(auth.user, id) });
  } catch (err) {
    return quoteErrorResponse(err);
  }
}

/** PATCH — edit content (bumps version, drops previous approval). */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireQuotesUser();
  if ('response' in auth) return auth.response;
  try {
    const { id } = await params;
    return NextResponse.json({ quote: await updateQuote(auth.user, id, await readJson(request)) });
  } catch (err) {
    return quoteErrorResponse(err);
  }
}
