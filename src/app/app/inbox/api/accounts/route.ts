import { NextResponse } from 'next/server';
import { requireInboxUser, commsErrorResponse } from '../_shared';
import { listAccountsForUser } from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /app/inbox/api/accounts — accounts the user may work with. */
export async function GET() {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json({ accounts: await listAccountsForUser(auth.user) });
  } catch (err) {
    return commsErrorResponse(err);
  }
}
