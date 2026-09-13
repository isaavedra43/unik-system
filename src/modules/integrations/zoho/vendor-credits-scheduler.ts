import { createZohoScheduler, type ZohoScheduler } from './zoho-scheduler-factory';
import { vendorCreditsAdapter } from './vendor-credits-sync';

/**
 * Vendor Credits scheduler factory. Registered in instrumentation.ts with
 * a stagger offset so entities don't all fire at once.
 */
export function createVendorCreditsScheduler(startOffsetMs = 0): ZohoScheduler {
  return createZohoScheduler(vendorCreditsAdapter, startOffsetMs);
}
