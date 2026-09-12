import { NextRequest, NextResponse } from 'next/server';
import { requireInboxUser, commsErrorResponse, readJson } from '../../_shared';
import {
  conversationPatchSchema,
  getConversation,
  updateConversation,
} from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json({ conversation: await getConversation(auth.user, id) });
  } catch (err) {
    return commsErrorResponse(err);
  }
}

/** PATCH — assignment, status, priority, tags, subject, snooze. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const patch = conversationPatchSchema.parse(await readJson(request));
    return NextResponse.json({ conversation: await updateConversation(auth.user, id, patch) });
  } catch (err) {
    return commsErrorResponse(err);
  }
}
