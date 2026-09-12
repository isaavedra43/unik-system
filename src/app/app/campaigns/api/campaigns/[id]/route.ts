import { NextRequest, NextResponse } from 'next/server';
import {
  requireCampaignsManager,
  requireCampaignsViewer,
  campaignErrorResponse,
  readJson,
} from '../../_shared';
import { getCampaign, updateCampaign } from '@/modules/campaigns/campaign-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCampaignsViewer();
  if ('response' in auth) return auth.response;
  try {
    const { id } = await params;
    return NextResponse.json({ campaign: await getCampaign(auth.user, id) });
  } catch (err) {
    return campaignErrorResponse(err);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCampaignsManager();
  if ('response' in auth) return auth.response;
  try {
    const { id } = await params;
    return NextResponse.json({
      campaign: await updateCampaign(auth.user, id, await readJson(request)),
    });
  } catch (err) {
    return campaignErrorResponse(err);
  }
}
