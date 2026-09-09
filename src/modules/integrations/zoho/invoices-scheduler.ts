import { createZohoScheduler } from './zoho-scheduler-factory';
import { invoicesAdapter } from './invoices-sync';

/**
 * Invoices scheduler — NOT registered in instrumentation.ts during Phase 5.
 * Will be registered in Phase 7 (Sync Orchestration).
 */
export const invoicesScheduler = createZohoScheduler(invoicesAdapter);
