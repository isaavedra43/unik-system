import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { broadcastMessage } from '@/modules/chat/chat-service';
import { apiErrorResponse } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const broadcastSchema = z.object({
  channelIds: z.array(z.string().min(1)).min(1).max(5),
  content: z.string().min(1).max(10000),
  attachmentIds: z.array(z.string().min(1)).optional(),
  priority: z.enum(['normal', 'urgent']).optional(),
});

export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'chat.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const parsed = broadcastSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Datos inválidos', details: parsed.error.issues },
      { status: 400 }
    );

  try {
    const messages = await broadcastMessage(session.user, parsed.data);
    return NextResponse.json({ data: messages });
  } catch (err) {
    return apiErrorResponse(err, { status: 400, safeNames: ['ChatError'], context: 'chat' });
  }
}
