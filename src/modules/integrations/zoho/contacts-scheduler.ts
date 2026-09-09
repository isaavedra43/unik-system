import { contactsAdapter } from './contacts-sync';
import { createZohoScheduler, type ZohoScheduler } from './zoho-scheduler-factory';

/**
 * Scheduler for Zoho Contacts sync.
 *
 * NOT registered in instrumentation.ts during Phases 2-5.
 * Will be enabled in Phase 7 (Sync Orchestration) after manual validation.
 */
let scheduler: ZohoScheduler | null = null;

export function getContactsScheduler(): ZohoScheduler {
  if (!scheduler) {
    scheduler = createZohoScheduler(contactsAdapter);
  }
  return scheduler;
}

export async function startContactsScheduler(): Promise<void> {
  await getContactsScheduler().start();
}

export function stopContactsScheduler(): void {
  getContactsScheduler().stop();
}
