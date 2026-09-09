import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { listBookmarks, bookmarkMessage, unbookmarkMessage } from '@/modules/chat/chat-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  messageId: z.string(),
});

export async function GET() {
  const session = await getCurrentSession();
  if (!session || !(await hasPermission(session.user, 'chat.use'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const bookmarks = await listBookmarks(session.user.id);
  return NextResponse.json({ bookmarks });
}

export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session || !(await hasPermission(session.user, 'chat.use'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = BodySchema.parse(await request.json());
  await bookmarkMessage(session.user, body.messageId);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session || !(await hasPermission(session.user, 'chat.use'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const messageId = searchParams.get('messageId');
  if (!messageId) {
    return NextResponse.json({ error: 'messageId is required' }, { status: 400 });
  }
  await unbookmarkMessage(session.user, messageId);
  return NextResponse.json({ ok: true });
}
