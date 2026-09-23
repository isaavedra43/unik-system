import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { listProductMedia } from '@/modules/visual-studio/visual-service';
import { storageErrorResponse } from '@/app/app/files/api/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const { id } = await params;
  try {
    return NextResponse.json({ media: await listProductMedia(session.user, id) });
  } catch (err) {
    return storageErrorResponse(err);
  }
}
