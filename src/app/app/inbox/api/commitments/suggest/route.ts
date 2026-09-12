import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireInboxUser, commsErrorResponse, readJson } from '../../_shared';
import { suggestCommitments } from '@/modules/comms/commitments-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST { text } — heuristic commitment suggestions; nothing is persisted. */
export async function POST(request: NextRequest) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  try {
    const { text } = z.object({ text: z.string().min(1).max(8000) }).parse(await readJson(request));
    return NextResponse.json({ suggestions: suggestCommitments(text) });
  } catch (err) {
    return commsErrorResponse(err);
  }
}
