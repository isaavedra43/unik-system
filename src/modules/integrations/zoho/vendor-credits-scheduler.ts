import { createZohoScheduler } from './zoho-scheduler-factory';
import { vendorCreditsAdapter } from './vendor-credits-sync';

/**
 * Vendor Credits scheduler — NOT registered in instrumentation.ts during initial phase.
 * Will be registered after manual validation of the sync.
 */
export const vendorCreditsScheduler = createZohoScheduler(vendorCreditsAdapter);
