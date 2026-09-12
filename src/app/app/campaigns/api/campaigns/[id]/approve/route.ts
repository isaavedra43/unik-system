import { NextRequest, NextResponse } from 'next/server';
import { requireCampaignsApprover, campaignErrorResponse, readJson } from '../../../_shared';
import { approveCampaign } from '@/modules/campaigns/campaign-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCampaignsApprover();
  if ('response' in auth) return auth.response;
  try {
    const { id } = await params;
    return NextResponse.json({
      campaign: await approveCampaign(auth.user, id, await readJson(request)),
    });
  } catch (err) {
    return campaignErrorResponse(err);
  }
}
