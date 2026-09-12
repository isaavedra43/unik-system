import { NextRequest, NextResponse } from 'next/server';
import { requireQuotesUser, quoteErrorResponse } from '../../../_shared';
import { buildCommercialPackage } from '@/modules/quotes/quotes-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireQuotesUser();
  if ('response' in auth) return auth.response;
  try {
    const { id } = await params;
    void request;
    const result = await buildCommercialPackage(auth.user, id);
    return NextResponse.json({
      ...result,
      downloadPath: `/app/files/api/objects/${result.documentId}/access?disposition=attachment`,
    });
  } catch (err) {
    return quoteErrorResponse(err);
  }
}
