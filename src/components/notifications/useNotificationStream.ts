'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { NotificationRow } from '@/modules/notifications/notification-service';

/**
 * Live notifications for the app shell: one SSE connection on the user's
 * channel keeps the bell badge exact and shows a toast for every new
 * notification while a tab is open. Service-worker messages (a push that
 * arrived while this tab was open, or a tap on an OS notification) are
 * handled here too, so the phone and the tab never disagree.
 */

interface StreamState {
  unread: number;
  latest: NotificationRow | null;
}

const POLL_FALLBACK_MS = 90_000;

export function useNotificationStream(userId: string, options: { toasts?: boolean } = {}) {
  const router = useRouter();
  const [state, setState] = useState<StreamState>({ unread: 0, latest: null });
  const showToasts = options.toasts ?? true;
  const routerRef = useRef(router);
  routerRef.current = router;

  const refreshUnread = useCallback(async () => {
    try {
      const res = await fetch('/app/notifications/api/unread-count', { cache: 'no-store' });
      if (res.ok) {
        const json = (await res.json()) as { count: number };
        setState((s) => ({ ...s, unread: json.count }));
      }
    } catch {
      // keep the previous value
    }
  }, []);

  useEffect(() => {
    void refreshUnread();
    const poll = setInterval(refreshUnread, POLL_FALLBACK_MS);
    return () => clearInterval(poll);
  }, [refreshUnread]);

  useEffect(() => {
    if (!userId || typeof window === 'undefined' || !('EventSource' in window)) return;
    const source = new EventSource(
      `/app/realtime/api/stream?channels=${encodeURIComponent(`user:${userId}`)}`
    );

    const onNotification = (event: MessageEvent) => {
      try {
        const envelope = JSON.parse(event.data) as { payload: NotificationRow };
        const row = envelope.payload;
        if (!row || !row.id) return;
        setState((s) => ({ unread: row.readAt ? s.unread : s.unread + 1, latest: row }));
        if (showToasts && document.visibilityState === 'visible') {
          toast(row.title, {
            description: row.body ?? undefined,
            duration: row.category === 'call_incoming' ? 20_000 : 6000,
            action: row.url
              ? {
                  label: 'Abrir',
                  onClick: () => {
                    void fetch('/app/notifications/api/read', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ id: row.id }),
                    }).catch(() => undefined);
                    routerRef.current.push(row.url!);
                  },
                }
              : undefined,
          });
        }
      } catch {
        // malformed frame
      }
    };
    const onRead = (event: MessageEvent) => {
      try {
        const envelope = JSON.parse(event.data) as { payload: { unread: number } };
        if (typeof envelope.payload?.unread === 'number') {
          setState((s) => ({ ...s, unread: envelope.payload.unread }));
        }
      } catch {
        // ignore
      }
    };
    source.addEventListener('notification', onNotification as EventListener);
    source.addEventListener('notification_read', onRead as EventListener);
    return () => {
      source.removeEventListener('notification', onNotification as EventListener);
      source.removeEventListener('notification_read', onRead as EventListener);
      source.close();
    };
  }, [userId, showToasts]);

  // Messages from public/sw.js
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'unik:push') void refreshUnread();
      if (data.type === 'unik:navigate' && data.url) routerRef.current.push(data.url);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [refreshUnread]);

  const setUnread = useCallback((value: number | ((prev: number) => number)) => {
    setState((s) => ({ ...s, unread: typeof value === 'function' ? value(s.unread) : value }));
  }, []);

  return { unread: state.unread, latest: state.latest, refreshUnread, setUnread };
}
