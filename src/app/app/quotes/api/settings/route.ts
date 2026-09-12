import { NextRequest, NextResponse } from 'next/server';
import { requireQuotesApprover, requireQuotesUser, quoteErrorResponse, readJson } from '../_shared';
import { getQuoteSettings, updateQuoteSettings } from '@/modules/quotes/quotes-service';
import { quoteSettingsSchema } from '@/modules/quotes/quotes-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireQuotesUser();
  if ('response' in auth) return auth.response;
  return NextResponse.json({ settings: await getQuoteSettings() });
}

/** PUT — commercial conditions printed in every package (quotes.approve). */
export async function PUT(request: NextRequest) {
  const auth = await requireQuotesApprover();
  if ('response' in auth) return auth.response;
  try {
    const patch = quoteSettingsSchema.partial().parse(await readJson(request));
    return NextResponse.json({ settings: await updateQuoteSettings(auth.user, patch) });
  } catch (err) {
    return quoteErrorResponse(err);
  }
}
