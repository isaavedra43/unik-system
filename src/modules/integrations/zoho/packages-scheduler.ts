import { createZohoScheduler } from './zoho-scheduler-factory';
import { packagesAdapter } from './packages-sync';

/**
 * Packages scheduler — NOT registered in instrumentation.ts during Phase 4.
 * Will be registered in Phase 7 (Sync Orchestration).
 */
export const packagesScheduler = createZohoScheduler(packagesAdapter);
