import { createZohoScheduler, type ZohoScheduler } from './zoho-scheduler-factory';
import { productsAdapter } from './products-sync';

/**
 * Products scheduler factory. Registered in instrumentation.ts with a
 * stagger offset so entities don't all fire at once.
 */
export function createProductsScheduler(startOffsetMs = 0): ZohoScheduler {
  return createZohoScheduler(productsAdapter, startOffsetMs);
}
