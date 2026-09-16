'use client';

import { useEffect, useRef } from 'react';

/**
 * Subscribes to operational realtime messages (`ops.events` on `case:{id}` /
 * `area:{key}`, `ops.workitems` on `user:{id}`) through the generic SSE stream.
 * The server drops channels the user may not read. The latest `onEvent` is
 * used without reopening the connection; the browser reconnects on its own.
 *
 * ONE connection per channel list, shared by every caller of the page: the chip
 * of the area shell, its work centre and its communications space all listen to
 * `area:<key>`, and before this pool each one opened its own `EventSource`. On
 * HTTP/1.1 the browser allows six connections per origin, so four permanent
 * streams left two for navigation, APIs and images; on the server it was twice
 * the open connections and twice the fan-out work, for nothing.
 */

type StreamHandler = (type: string, data: unknown) => void;

interface PooledStream {
  source: EventSource;
  /** How many subscribers keep it open. */
  refs: number;
  /** Event type → subscribers of this page. */
  listeners: Map<string, Set<StreamHandler>>;
  /** One DOM listener per type, fanned out to the subscribers above. */
  bound: Map<string, EventListener>;
}

const streams = new Map<string, PooledStream>();

function streamUrl(channelKey: string): string {
  return `/app/realtime/api/stream?channels=${encodeURIComponent(channelKey)}`;
}

function bindType(entry: PooledStream, type: string): void {
  if (entry.bound.has(type)) return;
  const bound: EventListener = (event) => {
    const message = event as MessageEvent;
    let data: unknown = null;
    try {
      data = JSON.parse(message.data);
    } catch {
      return;
    }
    for (const handler of [...(entry.listeners.get(type) ?? [])]) handler(message.type, data);
  };
  entry.bound.set(type, bound);
  entry.source.addEventListener(type, bound);
}

/**
 * Opens (or joins) the shared stream of `channelKey` and listens to `types`.
 * Returns the unsubscribe function; the connection closes when the last
 * subscriber leaves. Exported for the unit test.
 */
export function subscribeToOperationsStream(
  channelKey: string,
  types: readonly string[],
  handler: StreamHandler
): () => void {
  let entry = streams.get(channelKey);
  if (!entry) {
    entry = {
      source: new EventSource(streamUrl(channelKey)),
      refs: 0,
      listeners: new Map(),
      bound: new Map(),
    };
    streams.set(channelKey, entry);
  }
  const stream = entry;
  stream.refs += 1;
  for (const type of types) {
    bindType(stream, type);
    const set = stream.listeners.get(type) ?? new Set<StreamHandler>();
    set.add(handler);
    stream.listeners.set(type, set);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const type of types) stream.listeners.get(type)?.delete(handler);
    stream.refs -= 1;
    if (stream.refs > 0) return;
    for (const [type, bound] of stream.bound) stream.source.removeEventListener(type, bound);
    stream.source.close();
    if (streams.get(channelKey) === stream) streams.delete(channelKey);
  };
}

/** Open connections right now (the unit test asserts there is only one). */
export function openOperationsStreamCount(): number {
  return streams.size;
}

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
    const handler: StreamHandler = (type, data) => handlerRef.current(type, data);
    return subscribeToOperationsStream(channelKey, typeKey.split(','), handler);
  }, [channelKey, typeKey]);
}
