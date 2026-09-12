import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireInboxUser, commsErrorResponse, readJson } from '../../../_shared';
import { getConversation, listMessages, sendOutboundMessage } from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sendSchema = z.object({
  body: z.string().max(4000).default(''),
  mediaObjectIds: z.array(z.string()).max(10).optional(),
});

/** GET ?before=<messageId>&limit — chronological page of messages. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const q = request.nextUrl.searchParams;
    const result = await listMessages(auth.user, id, {
      before: q.get('before') ?? undefined,
      limit: q.get('limit') ? Number(q.get('limit')) : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return commsErrorResponse(err);
  }
}

/** POST — sends a message through the account's channel adapter. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const input = sendSchema.parse(await readJson(request));
    const conversation = await getConversation(auth.user, id);
    const message = await sendOutboundMessage({
      accountId: conversation.accountId,
      conversationId: id,
      body: input.body,
      mediaObjectIds: input.mediaObjectIds,
      sentByUserId: auth.user.id,
      actor: auth.user,
    });
    return NextResponse.json({ message }, { status: 201 });
  } catch (err) {
    return commsErrorResponse(err);
  }
}
