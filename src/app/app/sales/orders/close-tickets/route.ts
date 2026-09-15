import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { enqueueJob, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { CLOSE_TICKETS_MAX_ORDERS } from '@/modules/sales/close-tickets-service';
import { CLOSE_TICKETS_JOB_TYPE, type CloseTicketsPayload } from '@/modules/sales/close-tickets-jobs';

export const runtime = 'nodejs';

const bodySchema = z.object({
  orderIds: z.array(z.string().min(1).max(40)).min(1).max(CLOSE_TICKETS_MAX_ORDERS),
});

export async function POST(req: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'sales_orders.close_tickets'))
    return NextResponse.json({ error: 'Sin permiso para cerrar tickets' }, { status: 403 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: `Selecciona entre 1 y ${CLOSE_TICKETS_MAX_ORDERS} órdenes` },
      { status: 400 }
    );

  const orderIds = [...new Set(parsed.data.orderIds)];
  const job = await enqueueJob<CloseTicketsPayload>({
    type: CLOSE_TICKETS_JOB_TYPE,
    payload: { orderIds, actorId: session.user.id },
    priority: JOB_PRIORITY.interactive,
    maxAttempts: 1,
    createdBy: session.user.id,
  });
  return NextResponse.json({ jobId: job.id, total: orderIds.length });
}
