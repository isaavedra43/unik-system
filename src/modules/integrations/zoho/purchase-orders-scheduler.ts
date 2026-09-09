import { createZohoScheduler } from './zoho-scheduler-factory';
import { purchaseOrdersAdapter } from './purchase-orders-sync';

/**
 * Purchase Orders scheduler — NOT registered in instrumentation.ts during initial phase.
 * Will be registered after manual validation of the sync.
 */
export const purchaseOrdersScheduler = createZohoScheduler(purchaseOrdersAdapter);
