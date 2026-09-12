import { NextRequest, NextResponse } from 'next/server';
import { requireInboxUser, commsErrorResponse, readJson } from '../../_shared';
import { updateCommitment, updateCommitmentSchema } from '@/modules/comms/commitments-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const patch = updateCommitmentSchema.parse(await readJson(request));
    return NextResponse.json({ commitment: await updateCommitment(auth.user, id, patch) });
  } catch (err) {
    return commsErrorResponse(err);
  }
}
