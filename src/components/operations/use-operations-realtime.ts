'use client';

import { useEffect, useRef } from 'react';

/**
 * Subscribes to operational realtime messages (`ops.events` on `case:{id}` /
 * `area:{key}`, `ops.workitems` on `user:{id}`) through the generic SSE stream.
 * The server drops channels the user may not read. The latest `onEvent` is
 * used without reopening the connection; the browser reconnects on its own.
 */
export function useOperationsRealtime(
  channels: readonly string[],
  types: readonly string[],
  onEvent: (type: string, data: unknown) => void
): void {
  const handlerRef = useRef(onEvent);
  useEffect(() => {
    handlerRef.current = onEvent;
  }, [onEvent]);

  const channelKey = [...new Set(channels.filter(Boolean))].sort().join(',');
  const typeKey = [...new Set(types.filter(Boolean))].sort().join(',');

  useEffect(() => {
    if (!channelKey || !typeKey || typeof EventSource === 'undefined') return;
    const source = new EventSource(`/app/realtime/api/stream?channels=${encodeURIComponent(channelKey)}`);
    const eventTypes = typeKey.split(',');
    const listener = (event: MessageEvent) => {
      let data: unknown = null;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      handlerRef.current(event.type, data);
    };
    for (const type of eventTypes) source.addEventListener(type, listener as EventListener);
    return () => {
      for (const type of eventTypes) source.removeEventListener(type, listener as EventListener);
      source.close();
    };
  }, [channelKey, typeKey]);
}
