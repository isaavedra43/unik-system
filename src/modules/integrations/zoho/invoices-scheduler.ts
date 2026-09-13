import { createZohoScheduler, type ZohoScheduler } from './zoho-scheduler-factory';
import { invoicesAdapter } from './invoices-sync';

/**
 * Invoices scheduler factory. Registered in instrumentation.ts with a
 * stagger offset so entities don't all fire at once.
 */
export function createInvoicesScheduler(startOffsetMs = 0): ZohoScheduler {
  return createZohoScheduler(invoicesAdapter, startOffsetMs);
}
