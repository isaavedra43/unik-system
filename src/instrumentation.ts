/**
 * Next.js instrumentation hook. Runs once per server instance.
 * Registers all Zoho entity sync schedulers.
 * Each scheduler uses the shared organization-wide rate budget and
 * checks integration enabled status before starting.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  const { startSalesOrdersScheduler } =
    await import('@/modules/integrations/zoho/sales-orders-scheduler');
  const { startContactsScheduler } =
    await import('@/modules/integrations/zoho/contacts-scheduler');
  const { productsScheduler } =
    await import('@/modules/integrations/zoho/products-scheduler');
  const { packagesScheduler } =
    await import('@/modules/integrations/zoho/packages-scheduler');
  const { invoicesScheduler } =
    await import('@/modules/integrations/zoho/invoices-scheduler');

  void startSalesOrdersScheduler();
  void startContactsScheduler();
  void productsScheduler.start();
  void packagesScheduler.start();
  void invoicesScheduler.start();

  // Durable background jobs (object storage validation, cleanup, backups,
  // campaigns...). Handlers register on import; the worker claims jobs from
  // PostgreSQL with SKIP LOCKED so several instances can share the table.
  await import('@/modules/jobs/register-handlers');
  const { startJobWorker } = await import('@/modules/jobs/job-queue');
  const { startRecurringScheduler } = await import('@/modules/jobs/scheduled-jobs');
  startJobWorker();
  startRecurringScheduler();
}
