import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { rejectProposal, ProposalError } from '@/modules/extensions/proposals-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ reason: z.string().max(500).optional() });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const { id } = await params;
  let body: unknown = {};
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  try {
    const proposal = await rejectProposal(session.user, id, parsed.data.reason);
    const { prisma } = await import('@/lib/prisma');
    const run = await prisma.skillRun.findFirst({
      where: { proposalId: id, status: 'waiting_approval', userId: session.user.id },
    });
    if (run) {
      const { resumeSkillRun } = await import('@/modules/extensions/skill-runner');
      await resumeSkillRun(session.user, run.id).catch(() => undefined);
    }
    return NextResponse.json({ proposal });
  } catch (err) {
    if (err instanceof ProposalError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error' },
      { status: 500 }
    );
  }
}
