import { createZohoScheduler } from './zoho-scheduler-factory';
import { productsAdapter } from './products-sync';

/**
 * Products scheduler — NOT registered in instrumentation.ts during Phase 3.
 * Will be registered in Phase 7 (Sync Orchestration).
 */
export const productsScheduler = createZohoScheduler(productsAdapter);
