import { prisma } from '@/lib/prisma';
import { registerJobHandler, type JobContext } from '@/modules/jobs/job-queue';
import { isDailyLimitError } from '@/modules/integrations/zoho/zoho-sync-engine';
import { closeSalesOrderTicket, type CloseTicketResult } from './close-tickets-service';

/**
 * Bulk "cierre de ticket" job: closes the selected sales orders one by one
 * (sequential, each Zoho call goes through the shared rate budget). Partial
 * results are written to the job row after every order so the UI can show
 * progress. A single attempt: re-running blindly would repeat Zoho writes,
 * and each order already re-checks its state when the user runs it again.
 */

export const CLOSE_TICKETS_JOB_TYPE = 'sales_orders.close_tickets';

export interface CloseTicketsPayload {
  orderIds: string[];
  actorId: string;
}

export interface CloseTicketsJobResult {
  total: number;
  processed: number;
  results: CloseTicketResult[];
}

async function handleCloseTickets(ctx: JobContext<CloseTicketsPayload>): Promise<CloseTicketsJobResult> {
  const { orderIds, actorId } = ctx.payload;
  const summary: CloseTicketsJobResult = { total: orderIds.length, processed: 0, results: [] };

  for (const orderId of orderIds) {
    if (ctx.signal.aborted) break;
    let res: CloseTicketResult;
    try {
      res = await closeSalesOrderTicket({ id: actorId }, orderId);
    } catch (error) {
      if (isDailyLimitError(error)) throw error;
      res = {
        orderId,
        salesOrderNumber: null,
        outcome: 'failed',
        finalStatus: null,
        steps: [],
        error: error instanceof Error ? error.message : 'Error desconocido',
      };
    }
    summary.results.push(res);
    summary.processed += 1;
    ctx.log('close_ticket', { orderId, outcome: res.outcome });
    await prisma.backgroundJob
      .update({ where: { id: ctx.id }, data: { result: JSON.parse(JSON.stringify(summary)) } })
      .catch(() => undefined);
    await ctx.setProgress(Math.round((summary.processed / summary.total) * 100));
  }
  return summary;
}

registerJobHandler(CLOSE_TICKETS_JOB_TYPE, handleCloseTickets, { timeoutMs: 2 * 60 * 60 * 1000 });
