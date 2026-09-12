import { NextRequest, NextResponse } from 'next/server';
import { requireInboxAdmin, commsErrorResponse } from '../../../../../../inbox/api/_shared';
import { testAccount } from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST — configuration check against the provider (no message is sent). */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json(await testAccount(auth.user, id));
  } catch (err) {
    return commsErrorResponse(err);
  }
}
