import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireInboxUser, commsErrorResponse, readJson } from '../../../../_shared';
import { mergeDuplicate } from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST { survivorId? } — confirms the duplicate and merges it into the survivor. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const input = z.object({ survivorId: z.string().optional() }).parse(await readJson(request));
    return NextResponse.json(await mergeDuplicate(auth.user, id, input.survivorId));
  } catch (err) {
    return commsErrorResponse(err);
  }
}
