import { NextRequest, NextResponse } from 'next/server';
import { requireQuotesUser, quoteErrorResponse } from '../../../_shared';
import { requestApproval } from '@/modules/quotes/quotes-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireQuotesUser();
  if ('response' in auth) return auth.response;
  try {
    const { id } = await params;
    void request;
    return NextResponse.json({ quote: await requestApproval(auth.user, id) });
  } catch (err) {
    return quoteErrorResponse(err);
  }
}
