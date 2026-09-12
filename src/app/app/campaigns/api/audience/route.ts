import { NextRequest, NextResponse } from 'next/server';
import { requireCampaignsViewer, campaignErrorResponse, readJson } from '../_shared';
import { listAudienceTags, previewAudience } from '@/modules/campaigns/campaign-service';
import { audiencePreviewSchema } from '@/modules/campaigns/campaign-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — available contact tags with counts. */
export async function GET() {
  const auth = await requireCampaignsViewer();
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json({ tags: await listAudienceTags(auth.user) });
  } catch (err) {
    return campaignErrorResponse(err);
  }
}

/** POST { channel, filter } — count + consent breakdown + masked sample (nothing persisted). */
export async function POST(request: NextRequest) {
  const auth = await requireCampaignsViewer();
  if ('response' in auth) return auth.response;
  try {
    const input = audiencePreviewSchema.parse(await readJson(request));
    return NextResponse.json(await previewAudience(auth.user, input));
  } catch (err) {
    return campaignErrorResponse(err);
  }
}
