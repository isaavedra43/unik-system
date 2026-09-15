'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  getOfflineCommandClient,
  type FlushSummary,
  type OfflineCommandInput,
  type OfflineQueueState,
  type SubmitOutcome,
} from '@/lib/offline-commands';

const SERVER_STATE: OfflineQueueState = {
  userId: null,
  pending: 0,
  pendingOtherUsers: 0,
  stuck: 0,
  online: true,
  flushing: false,
  lastFlushAt: null,
  lastError: null,
  lastResults: [],
};

const getServerState = () => SERVER_STATE;

export interface OfflineCommandQueue extends OfflineQueueState {
  /** Sends the command now or keeps it for later. */
  submit: <P = unknown, D = unknown>(input: OfflineCommandInput<P>) => Promise<SubmitOutcome<D>>;
  /** Sends the pending commands right away (e.g. a "Sincronizar" button). */
  flush: () => Promise<FlushSummary>;
  /** Drops a pending command the user decided not to send. */
  discard: (commandId: string) => Promise<void>;
  /** Sends again a command that stopped after repeated server failures. */
  retry: (commandId: string) => Promise<FlushSummary>;
}

/**
 * Pending commands of this device, connectivity and manual flush.
 * `userId` is the session user, passed down from the server layout: only that
 * user's commands are sent, and commands other people left on the device stay
 * pending (`pendingOtherUsers`). Mounting it starts the automatic sync (online,
 * tab visible, every 30 s); several components can use it at the same time.
 */
export function useOfflineCommandQueue(userId: string): OfflineCommandQueue {
  const client = getOfflineCommandClient();
  const state = useSyncExternalStore(client.subscribe, client.getState, getServerState);

  // Declared before `start` so the first automatic flush already knows the user.
  useEffect(() => client.setUserId(userId), [client, userId]);
  useEffect(() => client.start(), [client]);

  const submit = useCallback(
    <P = unknown, D = unknown>(input: OfflineCommandInput<P>) => client.submit<P, D>(input),
    [client]
  );
  const flush = useCallback(() => client.flush(), [client]);
  const discard = useCallback((commandId: string) => client.discard(commandId), [client]);
  const retry = useCallback((commandId: string) => client.retry(commandId), [client]);

  return { ...state, submit, flush, discard, retry };
}
