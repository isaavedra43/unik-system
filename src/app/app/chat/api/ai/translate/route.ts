import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { translateMessage, ChatAiError } from '@/modules/chat/chat-ai-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  messageId: z.string(),
  targetLang: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session || !(await hasPermission(session.user, 'chat.use'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = BodySchema.parse(await request.json());
  try {
    const translation = await translateMessage(
      body.messageId,
      session.user.id,
      body.targetLang ?? 'es'
    );
    return NextResponse.json({ translation });
  } catch (err) {
    if (err instanceof ChatAiError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
