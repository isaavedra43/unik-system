import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { approveProposal, ProposalError } from '@/modules/extensions/proposals-service';
import { redactDeep } from '@/modules/extensions/secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST /app/assistant/api/proposals/[id]/approve
 * Authorizes the EXACT proposal (tool, version, connection, args, recipient,
 * files, context). Any material change since it was created invalidates it.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const { id } = await params;
  try {
    const { proposal, execution } = await approveProposal(session.user, id);
    // Resume a waiting skill run, if any.
    const { prisma } = await import('@/lib/prisma');
    const run = await prisma.skillRun.findFirst({
      where: { proposalId: id, status: 'waiting_approval', userId: session.user.id },
    });
    let skillRun: unknown = null;
    if (run) {
      const { resumeSkillRun } = await import('@/modules/extensions/skill-runner');
      skillRun = await resumeSkillRun(session.user, run.id).catch((err) => ({
        error: err instanceof Error ? err.message : 'error',
      }));
    }
    return NextResponse.json({
      proposal,
      execution: {
        success: execution.success,
        error: execution.error,
        uncertain: execution.uncertain,
        result: redactDeep(execution.result),
      },
      skillRun,
    });
  } catch (err) {
    if (err instanceof ProposalError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error' },
      { status: 500 }
    );
  }
}
