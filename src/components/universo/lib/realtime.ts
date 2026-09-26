'use client';

import { useEffect, useRef } from 'react';

/**
 * Realtime over /app/realtime/api/stream — ONE EventSource per channel set,
 * shared by every component that listens to it (the chat and the workspace
 * both follow `assistant:{id}`; HTTP/1.1 allows few connections per host).
 *
 * Frames are envelopes `{ channel, type, payload, createdAt }` — the payload
 * is the object the server published (the old workspace panel read the
 * envelope as if it were the payload, so nothing ever updated live).
 */
export interface RealtimeEnvelope<T = Record<string, unknown>> {
  channel?: string;
  type?: string;
  payload?: T;
  createdAt?: string;
}

type Listener = (ev: Event) => void;

interface Hub {
  es: EventSource;
  refs: number;
}

const hubs = new Map<string, Hub>();

function acquire(key: string): Hub {
  let hub = hubs.get(key);
  if (!hub) {
    hub = {
      es: new EventSource(`/app/realtime/api/stream?channels=${encodeURIComponent(key)}`),
      refs: 0,
    };
    hubs.set(key, hub);
  }
  hub.refs += 1;
  return hub;
}

function release(key: string, hub: Hub): void {
  hub.refs -= 1;
  if (hub.refs <= 0) {
    hub.es.close();
    if (hubs.get(key) === hub) hubs.delete(key);
  }
}

export function useRealtime(
  channels: Array<string | null | undefined>,
  types: readonly string[],
  onEvent: (type: string, payload: Record<string, unknown>, channel: string | undefined) => void,
  opts: { onReady?: () => void; onError?: () => void } = {}
): void {
  const handler = useRef(onEvent);
  const ready = useRef(opts.onReady);
  const failed = useRef(opts.onError);
  useEffect(() => {
    handler.current = onEvent;
    ready.current = opts.onReady;
    failed.current = opts.onError;
  });
  const key = channels
    .filter((c): c is string => Boolean(c))
    .sort()
    .join(',');
  const typeKey = types.join(',');

  useEffect(() => {
    if (!key || typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    const hub = acquire(key);
    const listener: Listener = (ev) => {
      try {
        const env = JSON.parse((ev as MessageEvent).data) as RealtimeEnvelope;
        handler.current(
          env.type ?? ev.type,
          (env.payload ?? {}) as Record<string, unknown>,
          env.channel
        );
      } catch {
        // malformed frame — ignore
      }
    };
    const list = typeKey.split(',').filter(Boolean);
    for (const t of list) hub.es.addEventListener(t, listener);
    const onReady = () => ready.current?.();
    const onError = () => failed.current?.();
    hub.es.addEventListener('ready', onReady);
    hub.es.addEventListener('error', onError);
    return () => {
      for (const t of list) hub.es.removeEventListener(t, listener);
      hub.es.removeEventListener('ready', onReady);
      hub.es.removeEventListener('error', onError);
      release(key, hub);
    };
  }, [key, typeKey]);
}

/** Small JSON fetch helper: throws Error(message) with the server's `error`. */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok)
    throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), {
      status: res.status,
      data,
    });
  return data;
}
