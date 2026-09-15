import { JOB_PRIORITY, registerJobHandler } from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import { onCaseStarted } from '@/modules/operations/case-service';
import './crm-commands';
import {
  linkCaseToOpportunities,
  processQuoteChangeEvent,
  relinkCasesOfSalesOrder,
  processRecentQuoteChanges,
  touchConversation,
} from './opportunities-service';
import { explainTopSignals, refreshRadar } from './radar-service';
import { runSalesOrderReadback } from './sales-order-write-service';
import {
  CRM_JOB_TYPES,
  CRM_QUOTE_CHANGES_EVERY_MS,
  CRM_RADAR_EXPLAIN_EVERY_MS,
  CRM_RADAR_REFRESH_EVERY_MS,
} from './types';

/**
 * Background jobs of Sales / CRM (plan 6.5). Import once from the job barrel
 * (`src/modules/jobs/register-handlers.ts`).
 *
 * - crm.conversation_touch {messageId}: timeline and timestamps of the
 *   opportunities of a message (the messaging fan-out calls
 *   `touchConversation` directly; the job allows re-running it by hand).
 * - crm.quote_changed {changeEventId?}: one quote change event, or (recurring,
 *   every 5 min) the sweep of the last 48 h of quote change events.
 * - crm.sales_order_readback {requestKey}: re-read of an order created from UNIK
 *   (enqueued 5 s after the write, 5 attempts); a mismatch opens an incident.
 * - crm.radar_refresh (every 15 min) and crm.radar_explain (every 24 h).
 *
 * It also links new cases to the opportunities of their sales order
 * (`onCaseStarted`, after the commit of `case.start`).
 */

registerJobHandler<{ messageId: string }>(CRM_JOB_TYPES.conversationTouch, async (ctx) => {
  const result = await touchConversation(ctx.payload.messageId);
  ctx.log('touch', { status: result.status, reason: result.reason ?? null });
  return result;
});

registerJobHandler<{ changeEventId?: string } | undefined>(CRM_JOB_TYPES.quoteChanged, async (ctx) => {
  const changeEventId = ctx.payload?.changeEventId;
  const result = changeEventId ? await processQuoteChangeEvent(changeEventId) : await processRecentQuoteChanges();
  ctx.log('quote_changes', { ...result });
  return result;
});

registerJobHandler<{ requestKey: string }>(
  CRM_JOB_TYPES.salesOrderReadback,
  async (ctx) => {
    const result = await runSalesOrderReadback(ctx.payload.requestKey);
    ctx.log('readback', { status: result.status, reason: result.reason ?? null, incidentId: result.incidentId ?? null });
    return result;
  },
  { timeoutMs: 2 * 60 * 1000 }
);

registerJobHandler<{ zohoSalesOrderId: string }>(CRM_JOB_TYPES.linkCases, async (ctx) => {
  const linked = await relinkCasesOfSalesOrder(ctx.payload.zohoSalesOrderId);
  ctx.log('link_cases', { linked });
  return { linked };
});

registerJobHandler(CRM_JOB_TYPES.radarRefresh, async (ctx) => {
  const result = await refreshRadar();
  ctx.log('radar_refresh', { ...result });
  return result;
}, { timeoutMs: 5 * 60 * 1000 });

registerJobHandler(CRM_JOB_TYPES.radarExplain, async (ctx) => {
  const result = await explainTopSignals();
  ctx.log('radar_explain', { ...result });
  return result;
}, { timeoutMs: 30 * 60 * 1000 });

registerRecurringJob({
  type: CRM_JOB_TYPES.quoteChanged,
  everyMs: CRM_QUOTE_CHANGES_EVERY_MS,
  priority: JOB_PRIORITY.maintenance,
});

registerRecurringJob({
  type: CRM_JOB_TYPES.radarRefresh,
  everyMs: CRM_RADAR_REFRESH_EVERY_MS,
  priority: JOB_PRIORITY.maintenance,
});

registerRecurringJob({
  type: CRM_JOB_TYPES.radarExplain,
  everyMs: CRM_RADAR_EXPLAIN_EVERY_MS,
  priority: JOB_PRIORITY.bulk,
});

type GlobalWithCrmListener = typeof globalThis & { __unikCrmCaseStartedUnsubscribe?: () => void };

const scope = globalThis as GlobalWithCrmListener;
// Hot reload re-imports this module: keep a single subscription.
scope.__unikCrmCaseStartedUnsubscribe?.();
scope.__unikCrmCaseStartedUnsubscribe = onCaseStarted(async (event) => {
  await linkCaseToOpportunities({ caseId: event.caseId, zohoSalesOrderId: event.zohoSalesOrderId });
});
