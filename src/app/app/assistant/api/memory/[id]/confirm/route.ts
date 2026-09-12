import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { decideMemory } from '@/modules/copilot/memory-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ accept: z.boolean() });

/** POST — the user confirms (or rejects) a memory/correction proposed by the assistant. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  const memory = await decideMemory(session.user.id, id, parsed.data.accept);
  if (!memory) return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  return NextResponse.json({ memory });
}
