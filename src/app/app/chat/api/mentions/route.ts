import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getUnreadMentions, markMentionsAsRead } from '@/modules/chat/chat-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  mentionIds: z.array(z.string()).optional(),
});

export async function GET() {
  const session = await getCurrentSession();
  if (!session || !(await hasPermission(session.user, 'chat.use'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const mentions = await getUnreadMentions(session.user.id);
  return NextResponse.json({ mentions });
}

export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session || !(await hasPermission(session.user, 'chat.use'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = BodySchema.parse(await request.json());
  await markMentionsAsRead(session.user.id, body.mentionIds);
  return NextResponse.json({ ok: true });
}
