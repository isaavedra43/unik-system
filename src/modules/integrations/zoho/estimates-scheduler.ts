import { createZohoScheduler } from './zoho-scheduler-factory';
import { estimatesAdapter } from './estimates-sync';

/**
 * Estimates (cotizaciones de Zoho Books) scheduler.
 * Registered in src/instrumentation.ts. Shares the organization-wide rate
 * budget with every other Zoho entity scheduler.
 */
export const estimatesScheduler = createZohoScheduler(estimatesAdapter);
