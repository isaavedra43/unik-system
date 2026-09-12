import { NextRequest, NextResponse } from 'next/server';
import { restoreVersion } from '@/modules/studio/studio-service';
import { requireStudio, studioErrorResponse } from '../../../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST — restores a version as a NEW version (history is never rewritten). */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> }
) {
  const auth = await requireStudio();
  if ('response' in auth) return auth.response;
  const { id, versionId } = await params;
  try {
    return NextResponse.json(await restoreVersion(auth.user, id, versionId));
  } catch (err) {
    return studioErrorResponse(err);
  }
}
