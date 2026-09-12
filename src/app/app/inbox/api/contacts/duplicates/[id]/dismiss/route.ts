import { NextRequest, NextResponse } from 'next/server';
import { requireInboxUser, commsErrorResponse } from '../../../../_shared';
import { dismissDuplicate } from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json({ contact: await dismissDuplicate(auth.user, id) });
  } catch (err) {
    return commsErrorResponse(err);
  }
}
