import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { summarizeConversation, ChatAiError } from '@/modules/chat/chat-ai-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  channelId: z.string(),
  since: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session || !(await hasPermission(session.user, 'chat.use'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = BodySchema.parse(await request.json());
  try {
    const summary = await summarizeConversation(
      body.channelId,
      session.user.id,
      body.since ? new Date(body.since) : undefined
    );
    return NextResponse.json({ summary });
  } catch (err) {
    if (err instanceof ChatAiError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
