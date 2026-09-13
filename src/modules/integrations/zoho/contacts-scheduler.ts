import { contactsAdapter } from './contacts-sync';
import { createZohoScheduler, type ZohoScheduler } from './zoho-scheduler-factory';

/**
 * Scheduler for Zoho Contacts sync. Registered in instrumentation.ts with
 * a stagger offset so entities don't all fire at once.
 */
let scheduler: ZohoScheduler | null = null;

export function getContactsScheduler(startOffsetMs = 0): ZohoScheduler {
  if (!scheduler) {
    scheduler = createZohoScheduler(contactsAdapter, startOffsetMs);
  }
  return scheduler;
}

export async function startContactsScheduler(startOffsetMs = 0): Promise<void> {
  await getContactsScheduler(startOffsetMs).start();
}

export function stopContactsScheduler(): void {
  getContactsScheduler().stop();
}
