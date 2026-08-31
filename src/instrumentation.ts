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

  startSalesOrdersScheduler();
}
