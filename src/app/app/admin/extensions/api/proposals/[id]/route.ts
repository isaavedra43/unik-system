import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  requireExtensionsAdmin,
  extensionErrorResponse,
  readJson,
} from '@/app/app/assistant/api/extensions/_shared';
import { resolvePendingReview, ProposalError } from '@/modules/extensions/proposals-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  outcome: z.enum(['executed', 'failed']),
  note: z.string().max(500).optional(),
});

/** PATCH — operator resolves an uncertain outcome after reconciling with the external system. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireExtensionsAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = schema.parse(await readJson(request));
    return NextResponse.json({
      proposal: await resolvePendingReview(auth.user, id, body.outcome, body.note),
    });
  } catch (err) {
    if (err instanceof ProposalError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return extensionErrorResponse(err);
  }
}
