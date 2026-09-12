import { NextResponse } from 'next/server';
import { requireCampaignsViewer, campaignErrorResponse } from '../_shared';
import { listCampaignAccounts } from '@/modules/campaigns/campaign-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — sending accounts available for the wizard (no credentials). */
export async function GET() {
  const auth = await requireCampaignsViewer();
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json({ accounts: await listCampaignAccounts(auth.user) });
  } catch (err) {
    return campaignErrorResponse(err);
  }
}
