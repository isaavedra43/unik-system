import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { clearMessageFeedback, FeedbackError, setMessageFeedback } from '@/modules/ai/ai-feedback-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  rating: z.union([z.literal(1), z.literal(-1)]),
  comment: z.string().max(1000).nullable().optional(),
});

/** POST: 👍/👎 (with optional comment) on one assistant message of the caller's conversation. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use')) return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos', details: parsed.error.issues }, { status: 400 });
  try {
    const feedback = await setMessageFeedback(session.user.id, id, parsed.data.rating, parsed.data.comment ?? null);
    return NextResponse.json({ feedback });
  } catch (err) {
    if (err instanceof FeedbackError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use')) return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const { id } = await params;
  try {
    await clearMessageFeedback(session.user.id, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof FeedbackError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
