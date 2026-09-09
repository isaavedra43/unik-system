import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { listTags, createTag } from '@/modules/chat/chat-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  name: z.string(),
  color: z.string().optional(),
});

export async function GET() {
  const session = await getCurrentSession();
  if (!session || !(await hasPermission(session.user, 'chat.use'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const tags = await listTags();
  return NextResponse.json({ tags });
}

export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session || !(await hasPermission(session.user, 'chat.use'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = BodySchema.parse(await request.json());
  const id = await createTag(session.user, body.name, body.color);
  return NextResponse.json({ id });
}
