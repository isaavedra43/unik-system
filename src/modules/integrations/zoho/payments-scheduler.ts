import { createZohoScheduler } from './zoho-scheduler-factory';
import { paymentsAdapter } from './payments-sync';

/**
 * Payments scheduler — NOT registered in instrumentation.ts during initial phase.
 * Will be registered after manual validation of the sync.
 */
export const paymentsScheduler = createZohoScheduler(paymentsAdapter);
