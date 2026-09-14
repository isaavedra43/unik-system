/**
 * Node.js-only startup: Zoho entity sync schedulers and the durable job worker.
 * Imported from instrumentation.ts inside `if (process.env.NEXT_RUNTIME === 'nodejs')` so the
 * Edge compilation never bundles these modules (they use `crypto`, Prisma, fs...).
 *
 * Schedulers are staggered by 30s so they don't all fire at once.
 */
export async function startNodeInstrumentation() {
  const { startSalesOrdersScheduler } =
    await import('@/modules/integrations/zoho/sales-orders-scheduler');
  const { startContactsScheduler } =
    await import('@/modules/integrations/zoho/contacts-scheduler');
  const { createProductsScheduler } =
    await import('@/modules/integrations/zoho/products-scheduler');
  const { createPackagesScheduler } =
    await import('@/modules/integrations/zoho/packages-scheduler');
  const { createInvoicesScheduler } =
    await import('@/modules/integrations/zoho/invoices-scheduler');
  const { createEstimatesScheduler } =
    await import('@/modules/integrations/zoho/estimates-scheduler');
  const { createBillsScheduler } =
    await import('@/modules/integrations/zoho/bills-scheduler');
  const { createPurchaseOrdersScheduler } =
    await import('@/modules/integrations/zoho/purchase-orders-scheduler');
  const { createPaymentsScheduler } =
    await import('@/modules/integrations/zoho/payments-scheduler');
  const { createVendorCreditsScheduler } =
    await import('@/modules/integrations/zoho/vendor-credits-scheduler');

  // Stagger schedulers by 30s to avoid all entities hitting Zoho at once.
  const STAGGER_MS = 30_000;
  void startSalesOrdersScheduler(0 * STAGGER_MS);
  void startContactsScheduler(1 * STAGGER_MS);
  void createProductsScheduler(2 * STAGGER_MS).start();
  void createPackagesScheduler(3 * STAGGER_MS).start();
  void createInvoicesScheduler(4 * STAGGER_MS).start();
  void createEstimatesScheduler(5 * STAGGER_MS).start();
  void createBillsScheduler(6 * STAGGER_MS).start();
  void createPurchaseOrdersScheduler(7 * STAGGER_MS).start();
  void createPaymentsScheduler(8 * STAGGER_MS).start();
  void createVendorCreditsScheduler(9 * STAGGER_MS).start();

  // Durable background jobs (object storage validation, cleanup, backups,
  // campaigns...). Handlers register on import; the worker claims jobs from
  // PostgreSQL with SKIP LOCKED so several instances can share the table.
  // Failures are logged loudly: without the worker, uploads stay "validating" forever.
  const log = (event: string, extra: Record<string, unknown> = {}) =>
    console.info(JSON.stringify({ component: 'instrumentation', event, ...extra }));
  try {
    log('jobs.registering_handlers');
    await import('@/modules/jobs/register-handlers');
    const { startJobWorker } = await import('@/modules/jobs/job-queue');
    const { startRecurringScheduler } = await import('@/modules/jobs/scheduled-jobs');
    startJobWorker();
    startRecurringScheduler();
    log('jobs.worker_start_requested');
  } catch (err) {
    console.error(
      JSON.stringify({
        component: 'instrumentation',
        event: 'jobs.start_failed',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split('\n').slice(0, 6).join(' | ') : undefined,
      })
    );
  }
}
