import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { votePoll } from '@/modules/chat/chat-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  optionIds: z.array(z.string()),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session || !(await hasPermission(session.user, 'chat.use'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const body = BodySchema.parse(await request.json());
  await votePoll(session.user, id, body.optionIds);
  return NextResponse.json({ ok: true });
}
