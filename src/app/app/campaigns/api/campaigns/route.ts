import { NextRequest, NextResponse } from 'next/server';
import {
  requireCampaignsManager,
  requireCampaignsViewer,
  campaignErrorResponse,
  readJson,
} from '../_shared';
import { createCampaign, listCampaigns } from '@/modules/campaigns/campaign-service';
import { hasPermission } from '@/modules/auth/authorization';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireCampaignsViewer();
  if ('response' in auth) return auth.response;
  try {
    const status = request.nextUrl.searchParams.get('status') ?? undefined;
    return NextResponse.json({
      campaigns: await listCampaigns(auth.user, { status }),
      canManage: hasPermission(auth.user, 'campaigns.manage'),
      canApprove: hasPermission(auth.user, 'campaigns.approve'),
    });
  } catch (err) {
    return campaignErrorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireCampaignsManager();
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json(
      { campaign: await createCampaign(auth.user, await readJson(request)) },
      { status: 201 }
    );
  } catch (err) {
    return campaignErrorResponse(err);
  }
}
