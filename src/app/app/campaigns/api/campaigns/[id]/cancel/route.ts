import { NextRequest, NextResponse } from 'next/server';
import { requireCampaignsManager, campaignErrorResponse } from '../../../_shared';
import { cancelCampaign } from '@/modules/campaigns/campaign-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCampaignsManager();
  if ('response' in auth) return auth.response;
  try {
    const { id } = await params;
    void request;
    return NextResponse.json({ campaign: await cancelCampaign(auth.user, id) });
  } catch (err) {
    return campaignErrorResponse(err);
  }
}
