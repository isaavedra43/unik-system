import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { CLOSE_TICKETS_JOB_TYPE } from '@/modules/sales/close-tickets-jobs';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'sales_orders.close_tickets'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  const { jobId } = await params;
  const job = await prisma.backgroundJob.findUnique({
    where: { id: jobId },
    select: { type: true, status: true, progress: true, result: true, lastError: true, createdBy: true },
  });
  if (!job || job.type !== CLOSE_TICKETS_JOB_TYPE || (job.createdBy !== session.user.id && !session.user.isSuperAdmin))
    return NextResponse.json({ error: 'No encontrado' }, { status: 404 });

  return NextResponse.json({
    status: job.status,
    progress: job.progress,
    result: job.result,
    error: job.lastError,
  });
}
