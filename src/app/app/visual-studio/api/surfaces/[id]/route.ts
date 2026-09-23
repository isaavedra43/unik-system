import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { refineSurfaceSchema } from '@/modules/visual-studio/visual-contract';
import { deleteSurface, refineSurface } from '@/modules/visual-studio/visual-service';
import { storageErrorResponse } from '@/app/app/files/api/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** Refina la máscara: nuevos clics contra la máscara previa o edición manual. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = refineSurfaceSchema.safeParse({ ...((body ?? {}) as object), surfaceId: id });
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  try {
    const surface = await refineSurface(session.user, parsed.data);
    return NextResponse.json({ surface });
  } catch (err) {
    return storageErrorResponse(err);
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const { id } = await params;
  try {
    await deleteSurface(session.user, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return storageErrorResponse(err);
  }
}
