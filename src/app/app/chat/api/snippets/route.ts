import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { listSnippets, createSnippet } from '@/modules/chat/chat-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  title: z.string(),
  content: z.string(),
});

export async function GET() {
  const session = await getCurrentSession();
  if (!session || !(await hasPermission(session.user, 'chat.use'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const snippets = await listSnippets(session.user.id);
  return NextResponse.json({ snippets });
}

export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session || !(await hasPermission(session.user, 'chat.use'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = BodySchema.parse(await request.json());
  const id = await createSnippet(session.user, body.title, body.content);
  return NextResponse.json({ id });
}
