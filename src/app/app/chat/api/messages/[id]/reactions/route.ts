import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { addReaction, removeReaction } from '@/modules/chat/chat-service';
import { apiErrorResponse } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const reactionSchema = z.object({
  emoji: z.string().min(1).max(10),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'chat.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const parsed = reactionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });

  try {
    const result = await addReaction(session.user, id, parsed.data.emoji);
    return NextResponse.json(result);
  } catch (err) {
    return apiErrorResponse(err, { status: 400, safeNames: ['ChatError'], context: 'chat' });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'chat.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const emoji = searchParams.get('emoji');

  if (!emoji) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
    }
    const parsed = reactionSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'emoji requerido' }, { status: 400 });
    try {
      const result = await removeReaction(session.user, id, parsed.data.emoji);
      return NextResponse.json(result);
    } catch (err) {
      return apiErrorResponse(err, { status: 400, safeNames: ['ChatError'], context: 'chat' });
    }
  }

  try {
    const result = await removeReaction(session.user, id, emoji);
    return NextResponse.json(result);
  } catch (err) {
    return apiErrorResponse(err, { status: 400, safeNames: ['ChatError'], context: 'chat' });
  }
}
