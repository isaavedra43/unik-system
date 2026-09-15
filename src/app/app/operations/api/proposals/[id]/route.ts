import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { approveProposal, rejectProposal } from '@/modules/extensions/proposals-service';
import { redactDeep } from '@/modules/extensions/secrets';
import {
  jsonError,
  operationsCopilotErrorResponse,
  readCopilotJson,
  requireOperationsUser,
} from '../../_http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

const decisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(500).optional(),
});

/**
 * POST { decision: approve | reject, reason? } — decides an AI proposal from any
 * operations surface (case room, area channel, Mi trabajo, Control Tower).
 *
 * No extra permission is required here on purpose: `approveProposal` /
 * `rejectProposal` enforce the approver scope (proposer, listed responsible or
 * backup, holder of the scope permission), refuse bots, hide proposals from
 * outsiders (404) and run the tool only after the second signature when the
 * tool needs two. A first signature answers `proposal.status =
 * 'awaiting_second_approval'` with `execution.errorCode` of the same name.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOperationsUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  if (!ID_PATTERN.test(id)) return jsonError(404, 'Propuesta no encontrada', 'not_found');
  try {
    const parsed = decisionSchema.safeParse(await readCopilotJson(request));
    if (!parsed.success) {
      return jsonError(400, 'Decisión inválida: usa "approve" o "reject"', 'invalid_request');
    }
    const { decision, reason } = parsed.data;
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
        errorCode: execution.errorCode,
        uncertain: execution.uncertain,
        needsApproval: execution.needsApproval,
        result: redactDeep(execution.result),
      },
    });
  } catch (err) {
    return operationsCopilotErrorResponse(err);
  }
}
