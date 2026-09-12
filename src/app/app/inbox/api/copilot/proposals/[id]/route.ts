import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireInboxUser, commsErrorResponse, readJson } from '../../../_shared';
import {
  approveProposal,
  rejectProposal,
  ProposalError,
} from '@/modules/extensions/proposals-service';
import { redactDeep } from '@/modules/extensions/secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST { decision: approve | reject, reason? } — decides a copilot proposal
 * (send message, etc.). Same guarantees as the assistant endpoint: only the
 * proposing user, exact stored arguments, expiry enforced.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const { decision, reason } = z
      .object({ decision: z.enum(['approve', 'reject']), reason: z.string().max(500).optional() })
      .parse(await readJson(request));
    if (decision === 'reject') {
      const proposal = await rejectProposal(auth.user, id, reason);
      return NextResponse.json({ proposal });
    }
    const { proposal, execution } = await approveProposal(auth.user, id);
    return NextResponse.json({
      proposal,
      execution: {
        success: execution.success,
        error: execution.error,
        uncertain: execution.uncertain,
        result: redactDeep(execution.result),
      },
    });
  } catch (err) {
    if (err instanceof ProposalError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return commsErrorResponse(err);
  }
}
