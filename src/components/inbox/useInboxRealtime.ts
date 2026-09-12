'use client';

import { useEffect, useRef } from 'react';
import type { RealtimeEnvelope } from './inbox-types';

/**
 * Subscribes to the generic SSE stream for the given channels. Events are
 * delivered to the latest `onEvent` without re-opening the connection on
 * every render; the browser reconnects automatically and resumes with the
 * last event id.
 */
export function useInboxRealtime(
  channels: string[],
  onEvent: (event: RealtimeEnvelope) => void
): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  const key = channels.filter(Boolean).sort().join(',');

  useEffect(() => {
    if (!key) return;
    const source = new EventSource(`/app/realtime/api/stream?channels=${encodeURIComponent(key)}`);
    const types = [
      'message',
      'message_status',
      'message_media',
      'conversation',
      'note',
      'handover',
      'commitment',
      'request',
    ];
    const listener = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as RealtimeEnvelope;
        handlerRef.current(data);
      } catch {
        // ignore malformed frames
      }
    };
    for (const type of types) source.addEventListener(type, listener as EventListener);
    return () => {
      for (const type of types) source.removeEventListener(type, listener as EventListener);
      source.close();
    };
  }, [key]);
}
