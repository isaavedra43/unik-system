'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Bell, Check, CheckCheck, Settings, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { duration, ease } from '@/lib/motion/presets';
import type { NotificationRow } from '@/modules/notifications/notification-service';
import { useNotificationStream } from './useNotificationStream';
import { notificationMeta, relativeTime } from './notification-meta';

const PAGE_SIZE = 15;

/**
 * Topbar bell + dropdown. Shows the latest notifications with category icons,
 * unread accent, mark-read / delete actions, live prepend over SSE and a
 * "mark all" / settings header. Replaces the old flat popover.
 */
export function NotificationBell({ userId }: { userId: string }) {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const { unread, setUnread, latest } = useNotificationStream(userId);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/app/notifications/api?page_size=${PAGE_SIZE}`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const json = (await res.json()) as { data: NotificationRow[]; unread: number };
        setRows(json.data);
        setUnread(json.unread);
      }
    } finally {
      setLoading(false);
    }
  }, [setUnread]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    void load();
  };

  // Live: fold a new notification into the list while the dropdown is open.
  useEffect(() => {
    if (!latest || !open) return;
    setRows((prev) => (prev.some((r) => r.id === latest.id) ? prev : [latest, ...prev]));
  }, [latest, open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const markRead = useCallback(
    (n: NotificationRow) => {
      if (n.readAt) return;
      setRows((prev) =>
        prev.map((r) => (r.id === n.id ? { ...r, readAt: new Date().toISOString() } : r))
      );
      setUnread((u) => Math.max(0, u - 1));
      void fetch('/app/notifications/api/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: n.id }),
      }).catch(() => undefined);
    },
    [setUnread]
  );

  const dismiss = useCallback(
    (n: NotificationRow) => {
      const wasUnread = !n.readAt;
      setRows((prev) => prev.filter((r) => r.id !== n.id));
      if (wasUnread) setUnread((u) => Math.max(0, u - 1));
      void fetch(`/app/notifications/api?id=${encodeURIComponent(n.id)}`, {
        method: 'DELETE',
      }).catch(() => undefined);
    },
    [setUnread]
  );

  const markAll = useCallback(() => {
    setRows((prev) =>
      prev.map((r) => ({ ...r, readAt: r.readAt ?? new Date().toISOString() }))
    );
    setUnread(0);
    void fetch('/app/notifications/api/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    }).catch(() => undefined);
  }, [setUnread]);

  const openItem = (n: NotificationRow) => {
    markRead(n);
    setOpen(false);
    router.push(n.url ?? '/app/notifications');
  };

  const hasUnreadInList = rows.some((r) => !r.readAt);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className="so-notification-bell"
        onClick={toggle}
        aria-label={`Notificaciones${unread > 0 ? ` (${unread} sin leer)` : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Bell size={18} />
        <AnimatePresence>
          {unread > 0 ? (
            <motion.span
              key="badge"
              initial={reduceMotion ? false : { scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.5, opacity: 0 }}
              transition={ease.spring}
              className="so-notification-badge"
            >
              {unread > 99 ? '99+' : unread}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            role="dialog"
            aria-label="Notificaciones recientes"
            initial={reduceMotion ? false : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: duration.fast, ease: ease.out }}
            className="bell-popover"
          >
            <div className="bell-head">
              <span className="bell-title">
                Notificaciones
                {unread > 0 ? <span className="bell-unread-pill">{unread}</span> : null}
              </span>
              <span className="bell-actions">
                {hasUnreadInList ? (
                  <button
                    type="button"
                    className="bell-icon-btn"
                    onClick={markAll}
                    aria-label="Marcar todas como leídas"
                    title="Marcar todas como leídas"
                  >
                    <CheckCheck size={15} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="bell-icon-btn"
                  aria-label="Configurar notificaciones"
                  title="Configurar"
                  onClick={() => {
                    setOpen(false);
                    router.push('/app/account/notifications');
                  }}
                >
                  <Settings size={15} />
                </button>
              </span>
            </div>

            <div className="bell-list" role="list">
              {loading && rows.length === 0 ? (
                <div className="bell-skeletons" aria-hidden="true">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="bell-skel">
                      <span className="bell-skel-icon" />
                      <span className="bell-skel-lines">
                        <span className="bell-skel-line w-2-5" />
                        <span className="bell-skel-line w-4-5" />
                      </span>
                    </div>
                  ))}
                </div>
              ) : rows.length === 0 ? (
                <div className="bell-empty">
                  <Bell size={22} aria-hidden="true" />
                  <p>Sin notificaciones</p>
                </div>
              ) : (
                rows.map((n) => {
                  const meta = notificationMeta(n.category);
                  const Icon = meta.icon;
                  const isUnread = !n.readAt;
                  return (
                    <div
                      key={n.id}
                      role="listitem"
                      tabIndex={0}
                      className={cn('bell-item', isUnread && 'unread')}
                      onClick={() => openItem(n)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openItem(n);
                        }
                      }}
                    >
                      <span className={cn('bell-item-icon', meta.tile)} aria-hidden="true">
                        <Icon size={15} />
                      </span>
                      <span className="bell-item-text">
                        <span className="bell-item-title">{n.title}</span>
                        {n.body ? <span className="bell-item-body">{n.body}</span> : null}
                        <span className="bell-item-time">{relativeTime(n.createdAt)}</span>
                      </span>
                      <span className="bell-item-actions">
                        {isUnread ? (
                          <button
                            type="button"
                            className="bell-icon-btn"
                            aria-label="Marcar como leída"
                            title="Marcar como leída"
                            onClick={(e) => {
                              e.stopPropagation();
                              markRead(n);
                            }}
                          >
                            <Check size={14} />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="bell-icon-btn danger"
                          aria-label="Eliminar notificación"
                          title="Eliminar"
                          onClick={(e) => {
                            e.stopPropagation();
                            dismiss(n);
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </span>
                    </div>
                  );
                })
              )}
            </div>

            <div className="bell-foot">
              <button
                type="button"
                className="bell-see-all"
                onClick={() => {
                  setOpen(false);
                  router.push('/app/notifications');
                }}
              >
                Ver todas
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
