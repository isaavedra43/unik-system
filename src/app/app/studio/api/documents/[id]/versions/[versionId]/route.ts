import { NextRequest, NextResponse } from 'next/server';
import { getVersion } from '@/modules/studio/studio-service';
import { requireStudio, studioErrorResponse } from '../../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — one version with its content (preview before restoring). */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> }
) {
  const auth = await requireStudio();
  if ('response' in auth) return auth.response;
  const { id, versionId } = await params;
  try {
    return NextResponse.json({ version: await getVersion(auth.user, id, versionId) });
  } catch (err) {
    return studioErrorResponse(err);
  }
}
