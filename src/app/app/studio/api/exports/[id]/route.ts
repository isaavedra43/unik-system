import { NextRequest, NextResponse } from 'next/server';
import { getExport } from '@/modules/studio/studio-export-service';
import { requireStudio, studioErrorResponse } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET — export state + verification. The file itself is fetched through
 * `/app/files/api/objects/:storageObjectId/access` (accessPath), which
 * re-checks the caller's access to the document that references the object.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireStudio();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json({ export: await getExport(auth.user, id) });
  } catch (err) {
    return studioErrorResponse(err);
  }
}
