import { NextRequest, NextResponse } from 'next/server';
import { requireInboxUser, commsErrorResponse, readJson } from '../_shared';
import {
  createCommitment,
  createCommitmentSchema,
  listCommitments,
} from '@/modules/comms/commitments-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  try {
    const q = request.nextUrl.searchParams;
    const scope = q.get('scope') === 'all' ? 'all' : 'mine';
    return NextResponse.json({
      commitments: await listCommitments(auth.user, {
        scope,
        status: q.get('status') ?? undefined,
        contactId: q.get('contactId') ?? undefined,
      }),
    });
  } catch (err) {
    return commsErrorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  try {
    const input = createCommitmentSchema.parse(await readJson(request));
    return NextResponse.json(
      { commitment: await createCommitment(auth.user, input) },
      { status: 201 }
    );
  } catch (err) {
    return commsErrorResponse(err);
  }
}
