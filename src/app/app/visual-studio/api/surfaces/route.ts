import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { createSurfaceSchema } from '@/modules/visual-studio/visual-contract';
import { createSurface } from '@/modules/visual-studio/visual-service';
import { storageErrorResponse } from '@/app/app/files/api/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** Crea una superficie nueva: SAM segmenta la foto con los puntos/caja dados. */
export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = createSurfaceSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  try {
    const surface = await createSurface(session.user, parsed.data);
    return NextResponse.json({ surface });
  } catch (err) {
    return storageErrorResponse(err);
  }
}
