'use client';

import {
  getOfflineCommandClient,
  type ClientCommandResult,
  type OfflineCommandInput,
  type SubmitOutcome,
} from '@/lib/offline-commands';
import { LOGISTICS_API } from '@/modules/areas/logistica/logistics-view-model';

/**
 * How the driver PWA sends a command (plan 6.3).
 *
 * Online it posts to the driver endpoint `POST /app/areas/logistica/chofer/api/commands`,
 * which only accepts the commands of a driver's day and checks that the person
 * is the driver of that trip. Offline — or when the network or the server fails
 * — the very same command (same `commandId`) is left in the shared offline
 * queue, which the service worker replays with Background Sync and the rest of
 * the app flushes on reconnect.
 *
 * Sending it twice is safe: the ledger of the engine replays the stored result
 * for a `commandId` it already saw, so a retry never delivers twice.
 */

/** Result of one command, with the shape `describeSubmitOutcome` reads. */
export type DriverSubmitOutcome = SubmitOutcome<Record<string, unknown>>;

function newCommandId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `drv-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

/** Asks the service worker to flush the queue as soon as the phone has signal. */
export function requestBackgroundSync(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready
    .then((registration) => {
      const sync = (
        registration as ServiceWorkerRegistration & {
          sync?: { register: (tag: string) => Promise<void> };
        }
      ).sync;
      return sync?.register('logistics-commands');
    })
    .catch(() => {
      // Background Sync is not available (iOS): the page flushes on reconnect.
    });
}

/**
 * Runs one driver command. Returns the same outcome shape the offline queue
 * returns, so the UI describes it with `describeSubmitOutcome`.
 */
export async function sendDriverCommand(
  input: OfflineCommandInput<Record<string, unknown>>
): Promise<DriverSubmitOutcome> {
  const client = getOfflineCommandClient();
  const command: OfflineCommandInput<Record<string, unknown>> = {
    ...input,
    commandId: input.commandId ?? newCommandId(),
  };
  const commandId = command.commandId as string;

  if (!isOnline()) {
    await client.enqueue(command);
    requestBackgroundSync();
    return { queued: true, commandId, reason: 'offline' };
  }

  let response: Response;
  try {
    response = await fetch(LOGISTICS_API.driverCommands, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: client.deviceId(),
        userId: client.getState().userId,
        commands: [
          {
            commandId,
            type: command.type,
            aggregate: command.aggregate,
            payload: command.payload,
            ...(command.expectedVersion !== undefined
              ? { expectedVersion: command.expectedVersion }
              : {}),
            ...(command.occurredAt ? { occurredAt: command.occurredAt } : {}),
          },
        ],
      }),
    });
  } catch {
    await client.enqueue(command);
    requestBackgroundSync();
    return { queued: true, commandId, reason: 'network' };
  }

  if (response.status === 401) {
    await client.enqueue(command);
    return { queued: true, commandId, reason: 'unauthenticated' };
  }

  const body = (await response.json().catch(() => null)) as {
    results?: ClientCommandResult<Record<string, unknown>>[];
  } | null;
  const result = body?.results?.find((entry) => entry.commandId === commandId);

  if (!result || response.status >= 500) {
    await client.enqueue(command);
    requestBackgroundSync();
    return { queued: true, commandId, reason: 'server' };
  }
  if (result.errorCode === 'actor_mismatch') {
    await client.enqueue(command);
    return { queued: true, commandId, reason: 'actor_mismatch' };
  }
  if (result.status === 'accepted') {
    // The same command is still running on the server: the queue reads its
    // final result on the next flush instead of losing it.
    await client.enqueue(command);
    return { queued: true, commandId, reason: 'in_flight' };
  }
  return { queued: false, commandId, result };
}
