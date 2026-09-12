import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireInboxUser, commsErrorResponse, readJson } from '../../../_shared';
import { handoverConversation } from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST { toUserId, summary? } — assisted operator handover (AI brief + internal note). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const input = z
      .object({ toUserId: z.string().min(1), summary: z.string().max(4000).optional() })
      .parse(await readJson(request));
    return NextResponse.json(
      await handoverConversation(auth.user, id, input.toUserId, input.summary)
    );
  } catch (err) {
    return commsErrorResponse(err);
  }
}
