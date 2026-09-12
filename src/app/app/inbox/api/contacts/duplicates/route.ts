import { NextResponse } from 'next/server';
import { requireInboxUser, commsErrorResponse } from '../../_shared';
import { listPendingDuplicates } from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json({ duplicates: await listPendingDuplicates(auth.user) });
  } catch (err) {
    return commsErrorResponse(err);
  }
}
