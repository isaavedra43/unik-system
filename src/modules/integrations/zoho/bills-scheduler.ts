import { createZohoScheduler, type ZohoScheduler } from './zoho-scheduler-factory';
import { billsAdapter } from './bills-sync';

/**
 * Bills scheduler factory. Registered in instrumentation.ts with a stagger
 * offset so entities don't all fire at once.
 */
export function createBillsScheduler(startOffsetMs = 0): ZohoScheduler {
  return createZohoScheduler(billsAdapter, startOffsetMs);
}
