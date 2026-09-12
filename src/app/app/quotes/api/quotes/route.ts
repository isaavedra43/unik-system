import { NextRequest, NextResponse } from 'next/server';
import { requireQuotesUser, quoteErrorResponse, readJson } from '../_shared';
import {
  createQuote,
  getBooksMode,
  getQuoteSettings,
  listQuotes,
} from '@/modules/quotes/quotes-service';
import { hasPermission } from '@/modules/auth/authorization';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /app/quotes/api/quotes?status=&search= — list with Books mode and capabilities. */
export async function GET(request: NextRequest) {
  const auth = await requireQuotesUser();
  if ('response' in auth) return auth.response;
  try {
    const params = request.nextUrl.searchParams;
    const [quotes, settings] = await Promise.all([
      listQuotes(auth.user, {
        status: params.get('status') ?? undefined,
        search: params.get('search') ?? undefined,
        limit: Number(params.get('limit') ?? 100) || 100,
      }),
      getQuoteSettings(),
    ]);
    const mode = getBooksMode();
    return NextResponse.json({
      quotes,
      booksMode: { mock: mode.mock, reason: mode.reason },
      settings,
      canApprove: hasPermission(auth.user, 'quotes.approve'),
    });
  } catch (err) {
    return quoteErrorResponse(err);
  }
}

/** POST /app/quotes/api/quotes — create a draft. */
export async function POST(request: NextRequest) {
  const auth = await requireQuotesUser();
  if ('response' in auth) return auth.response;
  try {
    const quote = await createQuote(auth.user, await readJson(request));
    return NextResponse.json({ quote }, { status: 201 });
  } catch (err) {
    return quoteErrorResponse(err);
  }
}
