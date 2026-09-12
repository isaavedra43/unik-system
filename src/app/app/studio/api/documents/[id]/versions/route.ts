import { NextRequest, NextResponse } from 'next/server';
import { listVersions } from '@/modules/studio/studio-service';
import { requireStudio, studioErrorResponse } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireStudio();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json({ versions: await listVersions(auth.user, id) });
  } catch (err) {
    return studioErrorResponse(err);
  }
}
