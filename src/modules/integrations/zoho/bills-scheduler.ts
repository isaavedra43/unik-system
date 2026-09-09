import { createZohoScheduler } from './zoho-scheduler-factory';
import { billsAdapter } from './bills-sync';

/**
 * Bills scheduler — NOT registered in instrumentation.ts during initial phase.
 * Will be registered after manual validation of the sync.
 */
export const billsScheduler = createZohoScheduler(billsAdapter);
