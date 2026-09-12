import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { deleteMemory, updateMemory } from '@/modules/copilot/memory-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  content: z.string().min(1).max(500).optional(),
  tags: z.array(z.string().max(40)).max(10).optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  const memory = await updateMemory(session.user.id, id, parsed.data);
  if (!memory) return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  return NextResponse.json({ memory });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const { id } = await params;
  return NextResponse.json({ deleted: await deleteMemory(session.user.id, id) });
}
