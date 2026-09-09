/**
 * Next.js instrumentation hook. Runs once per server instance.
 * Kept intentionally minimal: all scheduler logic lives in the Zoho module.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  const { startSalesOrdersScheduler } =
    await import('@/modules/integrations/zoho/sales-orders-scheduler');
  const { startPackagesScheduler } =
    await import('@/modules/integrations/zoho/packages-scheduler');
  const { startInvoicesScheduler } =
    await import('@/modules/integrations/zoho/invoices-scheduler');
  const { startVendorsScheduler } =
    await import('@/modules/integrations/zoho/vendors-scheduler');
  const { startItemsScheduler } =
    await import('@/modules/integrations/zoho/items-scheduler');

  void startSalesOrdersScheduler();
  void startPackagesScheduler();
  void startInvoicesScheduler();
  void startVendorsScheduler();
  void startItemsScheduler();
}
