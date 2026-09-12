import { NextRequest, NextResponse } from 'next/server';
import { rehearseSchema } from '@/modules/campaigns/campaign-contract';
import { requireCampaignsManager, campaignErrorResponse, readJson } from '../../../_shared';
import { rehearseCampaign } from '@/modules/campaigns/campaign-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCampaignsManager();
  if ('response' in auth) return auth.response;
  try {
    const { id } = await params;
    const body = rehearseSchema.parse(await readJson(request));
    return NextResponse.json(await rehearseCampaign(auth.user, id, body.sampleSize));
  } catch (err) {
    return campaignErrorResponse(err);
  }
}
