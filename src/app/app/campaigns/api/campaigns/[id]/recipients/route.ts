import { NextRequest, NextResponse } from 'next/server';
import { requireCampaignsViewer, campaignErrorResponse } from '../../../_shared';
import { listRecipients } from '@/modules/campaigns/campaign-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?status=&page=&pageSize= — paginated frozen recipients (identifiers masked). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCampaignsViewer();
  if ('response' in auth) return auth.response;
  try {
    const { id } = await params;
    const q = request.nextUrl.searchParams;
    return NextResponse.json(
      await listRecipients(auth.user, id, {
        status: q.get('status') ?? undefined,
        page: Number(q.get('page') ?? 1) || 1,
        pageSize: Number(q.get('pageSize') ?? 50) || 50,
      })
    );
  } catch (err) {
    return campaignErrorResponse(err);
  }
}
