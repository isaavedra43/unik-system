import { createZohoScheduler, type ZohoScheduler } from './zoho-scheduler-factory';
import { paymentsAdapter } from './payments-sync';

/**
 * Payments scheduler factory. Registered in instrumentation.ts with a
 * stagger offset so entities don't all fire at once.
 */
export function createPaymentsScheduler(startOffsetMs = 0): ZohoScheduler {
  return createZohoScheduler(paymentsAdapter, startOffsetMs);
}
