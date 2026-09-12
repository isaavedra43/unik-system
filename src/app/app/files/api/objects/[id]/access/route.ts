import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { resolveFileAccess } from '@/modules/storage/storage-access';
import { authorizeDownload } from '@/modules/storage/storage-service';
import { storageErrorResponse } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/files/api/objects/[id]/access?disposition=inline|attachment
 *
 * Re-checks the caller's CURRENT access to the resource that references the
 * object and returns a short-lived authorization: a signed URL (ordinary
 * files on R2, 5 minutes) or the authenticated streaming URL (restricted
 * content, legacy files, disk driver). Signed URLs are never stored or logged.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const { id } = await params;
  const disposition =
    request.nextUrl.searchParams.get('disposition') === 'attachment' ? 'attachment' : 'inline';
  try {
    const decision = await resolveFileAccess(session.user, id);
    if (!decision || !decision.allowed)
      return NextResponse.json({ error: 'Archivo no encontrado' }, { status: 404 });
    if (decision.object.status !== 'ready') {
      return NextResponse.json(
        { error: 'El archivo aún no está disponible', status: decision.object.status },
        { status: 409 }
      );
    }
    const auth = await authorizeDownload(decision.object, { disposition });
    return NextResponse.json({
      ...auth,
      fileName: decision.object.originalName,
      mimeType: decision.object.detectedMimeType ?? decision.object.declaredMimeType,
    });
  } catch (err) {
    return storageErrorResponse(err);
  }
}
