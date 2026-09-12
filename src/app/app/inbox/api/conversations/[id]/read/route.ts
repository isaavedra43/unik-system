import { NextRequest, NextResponse } from 'next/server';
import { requireInboxUser, commsErrorResponse } from '../../../_shared';
import { markConversationRead } from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    await markConversationRead(auth.user, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return commsErrorResponse(err);
  }
}
