import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCampaignsManager, campaignErrorResponse, readJson } from '../../../_shared';
import { pauseCampaign } from '@/modules/campaigns/campaign-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCampaignsManager();
  if ('response' in auth) return auth.response;
  try {
    const { id } = await params;
    const body = z
      .object({ reason: z.string().max(200).optional() })
      .parse(await readJson(request));
    return NextResponse.json({ campaign: await pauseCampaign(auth.user, id, body.reason) });
  } catch (err) {
    return campaignErrorResponse(err);
  }
}
