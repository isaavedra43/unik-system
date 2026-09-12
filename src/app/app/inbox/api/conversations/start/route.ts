import { NextRequest, NextResponse } from 'next/server';
import { requireInboxUser, commsErrorResponse, readJson } from '../../_shared';
import { startConversation, startConversationSchema } from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /app/inbox/api/conversations/start
 * Opens (or reopens) a conversation with a contact from one of the caller's
 * accounts and sends the first message through the common outbound door.
 */
export async function POST(request: NextRequest) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  try {
    const input = startConversationSchema.parse(await readJson(request));
    return NextResponse.json(await startConversation(auth.user, input), { status: 201 });
  } catch (err) {
    return commsErrorResponse(err);
  }
}
