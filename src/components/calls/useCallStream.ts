'use client';

import { useEffect, useRef } from 'react';

/**
 * Subscribes to the realtime channel `call:{id}` through the generic SSE
 * endpoint. Every event is `{ channel, type, payload }`; the hook keeps the
 * last event id as cursor so a reconnect replays what was missed.
 */
export interface CallStreamEvent {
  type: string;
  payload: Record<string, unknown>;
}

export const CALL_EVENT_TYPES = [
  'call_updated',
  'participant_joined',
  'participant_left',
  'ai_state',
  'recording_state',
  'recording_ready',
  'transcript_segment',
  'transcript_ready',
  'copilot_suggestion',
  'ai_reply',
  'summary_ready',
  'task_created',
  'supervision',
  'transfer',
  'call_ended',
] as const;

export function useCallStream(
  callId: string | null,
  onEvent: (event: CallStreamEvent) => void,
  onStatus?: (status: 'connecting' | 'open' | 'error') => void
): void {
  const handlerRef = useRef(onEvent);
  const statusRef = useRef(onStatus);
  handlerRef.current = onEvent;
  statusRef.current = onStatus;

  useEffect(() => {
    if (!callId) return;
    let cursor = '';
    let es: EventSource | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      statusRef.current?.('connecting');
      const url = `/app/realtime/api/stream?channels=${encodeURIComponent(`call:${callId}`)}${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`;
      es = new EventSource(url);
      es.onopen = () => statusRef.current?.('open');
      es.onerror = () => statusRef.current?.('error');
      for (const type of CALL_EVENT_TYPES) {
        es.addEventListener(type, (raw) => {
          const message = raw as MessageEvent<string>;
          if (message.lastEventId) cursor = message.lastEventId;
          try {
            const data = JSON.parse(message.data) as {
              type: string;
              payload: Record<string, unknown>;
            };
            handlerRef.current({ type: data.type ?? type, payload: data.payload ?? {} });
          } catch {
            // ignore malformed frames
          }
        });
      }
    };
    connect();
    return () => {
      closed = true;
      es?.close();
    };
  }, [callId]);
}
