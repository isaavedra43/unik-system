import { createZohoScheduler, type ZohoScheduler } from './zoho-scheduler-factory';
import { estimatesAdapter } from './estimates-sync';

/**
 * Estimates (cotizaciones de Zoho Books) scheduler factory. Registered in
 * instrumentation.ts with a stagger offset. Shares the organization-wide
 * rate budget with every other Zoho entity scheduler.
 */
export function createEstimatesScheduler(startOffsetMs = 0): ZohoScheduler {
  return createZohoScheduler(estimatesAdapter, startOffsetMs);
}
