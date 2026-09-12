import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { addMemory, clearMemory, listMemory } from '@/modules/copilot/memory-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  content: z.string().min(1).max(500),
  tags: z.array(z.string().max(40)).max(10).optional(),
});

export async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const includeArchived = request.nextUrl.searchParams.get('archived') === '1';
  return NextResponse.json({ memories: await listMemory(session.user.id, { includeArchived }) });
}

export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  return NextResponse.json(
    {
      memory: await addMemory(session.user.id, parsed.data.content, {
        source: 'user',
        tags: parsed.data.tags,
      }),
    },
    { status: 201 }
  );
}

export async function DELETE() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  return NextResponse.json({ deleted: await clearMemory(session.user.id) });
}
