import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { abortUpload } from '@/modules/storage/storage-service';
import { storageErrorResponse } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** DELETE /app/files/api/uploads/[id] — aborts an upload owned by the caller (idempotent). */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const { id } = await params;
  try {
    await abortUpload(session.user.id, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return storageErrorResponse(err);
  }
}
