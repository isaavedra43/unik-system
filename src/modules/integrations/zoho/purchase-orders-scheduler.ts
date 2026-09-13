import { createZohoScheduler, type ZohoScheduler } from './zoho-scheduler-factory';
import { purchaseOrdersAdapter } from './purchase-orders-sync';

/**
 * Purchase Orders scheduler factory. Registered in instrumentation.ts with
 * a stagger offset so entities don't all fire at once.
 */
export function createPurchaseOrdersScheduler(startOffsetMs = 0): ZohoScheduler {
  return createZohoScheduler(purchaseOrdersAdapter, startOffsetMs);
}
