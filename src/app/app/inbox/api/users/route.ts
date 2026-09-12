import { NextResponse } from 'next/server';
import { requireInboxUser, commsErrorResponse } from '../_shared';
import { listInboxUsers } from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /app/inbox/api/users — assignment / handover targets. */
export async function GET() {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json({ users: await listInboxUsers(auth.user) });
  } catch (err) {
    return commsErrorResponse(err);
  }
}
