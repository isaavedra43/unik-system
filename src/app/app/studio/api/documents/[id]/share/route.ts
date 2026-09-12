import { NextRequest, NextResponse } from 'next/server';
import { shareDocument } from '@/modules/studio/studio-service';
import { requireStudio, studioErrorResponse } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST — shares the approved version with the team (studio.approve). */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireStudio('studio.approve');
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json({ document: await shareDocument(auth.user, id) });
  } catch (err) {
    return studioErrorResponse(err);
  }
}
