import { NextRequest, NextResponse } from 'next/server';
import { requireCampaignsViewer, campaignErrorResponse } from '../../../../_shared';
import { renderForRecipient } from '@/modules/campaigns/campaign-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — exact message a recipient receives (frozen content + frozen personalization). */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; recipientId: string }> }
) {
  const auth = await requireCampaignsViewer();
  if ('response' in auth) return auth.response;
  try {
    const { id, recipientId } = await params;
    return NextResponse.json(await renderForRecipient(auth.user, id, recipientId));
  } catch (err) {
    return campaignErrorResponse(err);
  }
}
