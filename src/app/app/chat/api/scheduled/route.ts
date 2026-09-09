import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { listScheduledMessages, scheduleMessage } from '@/modules/chat/chat-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  channelId: z.string(),
  content: z.string(),
  sendAt: z.string(),
});

export async function GET() {
  const session = await getCurrentSession();
  if (!session || !(await hasPermission(session.user, 'chat.use'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const scheduled = await listScheduledMessages(session.user.id);
  return NextResponse.json({ scheduled });
}

export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session || !(await hasPermission(session.user, 'chat.use'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = BodySchema.parse(await request.json());
  const id = await scheduleMessage(
    session.user,
    body.channelId,
    body.content,
    new Date(body.sendAt)
  );
  return NextResponse.json({ id });
}
