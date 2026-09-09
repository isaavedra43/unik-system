import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { suggestSmartReplies, ChatAiError } from '@/modules/chat/chat-ai-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  channelId: z.string(),
});

export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session || !(await hasPermission(session.user, 'chat.use'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = BodySchema.parse(await request.json());
  try {
    const replies = await suggestSmartReplies(body.channelId, session.user.id);
    return NextResponse.json({ replies });
  } catch (err) {
    if (err instanceof ChatAiError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
