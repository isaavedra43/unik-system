'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Bell,
  BellRing,
  Bot,
  Check,
  CheckCheck,
  Eye,
  MessageCircle,
  Phone,
  PhoneMissed,
  Settings,
  Smartphone,
  Inbox,
  Workflow,
} from 'lucide-react';
import { toast } from 'sonner';
import type { NotificationRow } from '@/modules/notifications/notification-service';
import { NOTIFICATION_CATALOG } from '@/modules/notifications/catalog';
import { useNotificationStream } from './useNotificationStream';
import { usePushSubscription } from './usePushSubscription';

interface NotificationsPageProps {
  userId: string;
  initialData: { data: NotificationRow[]; total: number; unread: number };
}

type Filter = 'all' | 'unread';

const GROUP_ICONS: Record<string, React.ReactNode> = {
  Llamadas: <Phone size={16} />,
  Mensajes: <MessageCircle size={16} />,
  'Asistente IA': <Bot size={16} />,
  Seguimiento: <Eye size={16} />,
  Operaciones: <Workflow size={16} />,
  Sistema: <Bell size={16} />,
};

function iconFor(category: string): React.ReactNode {
  if (category === 'call_missed') return <PhoneMissed size={16} />;
  if (category === 'call_incoming') return <PhoneMissed size={16} />;
  if (category === 'inbox_message' || category === 'inbox_assigned') return <Inbox size={16} />;
  const def = NOTIFICATION_CATALOG.find((c) => c.key === category);
  return GROUP_ICONS[def?.group ?? 'Sistema'] ?? <Bell size={16} />;
}

function relativeTime(value: string): string {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `hace ${days} d`;
  try {
    return date.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return value;
  }
}

const GROUPS = [...new Set(NOTIFICATION_CATALOG.map((c) => c.group))];

export function NotificationsPage({ userId, initialData }: NotificationsPageProps) {
  const router = useRouter();
  const [notifications, setNotifications] = useState(initialData.data);
  const [filter, setFilter] = useState<Filter>('all');
  const [group, setGroup] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { unread, setUnread, latest } = useNotificationStream(userId, { toasts: false });
  const push = usePushSubscription();

  // Live: prepend new rows as they arrive on the SSE channel.
  useEffect(() => {
    if (!latest) return;
    setNotifications((prev) => (prev.some((n) => n.id === latest.id) ? prev : [latest, ...prev]));
  }, [latest]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page_size: '100' });
      if (filter === 'unread') params.set('unread', 'true');
      const res = await fetch(`/app/notifications/api?${params.toString()}`, { cache: 'no-store' });
      if (res.ok) {
        const json = (await res.json()) as { data: NotificationRow[]; unread: number };
        setNotifications(json.data);
        setUnread(json.unread);
      }
    } finally {
      setLoading(false);
    }
  }, [filter, setUnread]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = useMemo(() => {
    const categoriesInGroup = group
      ? new Set(NOTIFICATION_CATALOG.filter((c) => c.group === group).map((c) => c.key as string))
      : null;
    return notifications.filter((n) => {
      if (filter === 'unread' && n.readAt) return false;
      if (categoriesInGroup && !categoriesInGroup.has(n.category)) return false;
      return true;
    });
  }, [notifications, filter, group]);

  const markRead = useCallback(
    async (id: string) => {
      setNotifications((prev) =>
        prev.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n))
      );
      setUnread((u) => Math.max(0, u - 1));
      await fetch('/app/notifications/api/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).catch(() => undefined);
    },
    [setUnread]
  );

  const open = async (n: NotificationRow) => {
    if (!n.readAt) void markRead(n.id);
    if (n.url) router.push(n.url);
  };

  const markAll = async () => {
    const res = await fetch('/app/notifications/api/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    if (res.ok) {
      setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
      setUnread(0);
      toast.success('Todas las notificaciones marcadas como leídas');
    } else {
      toast.error('No se pudo marcar como leídas');
    }
  };

  const showPushBanner = push.status === 'prompt' || push.status === 'needs_install';

  return (
    <div>
      <div className="page-header page-header-row">
        <div className="page-header-info">
          <h1 className="page-title">Notificaciones</h1>
          <p className="page-description">{unread > 0 ? `${unread} sin leer` : 'Todo al día'}</p>
        </div>
        <div className="row-actions">
          {unread > 0 ? (
            <button className="btn btn-secondary btn-sm" onClick={markAll} type="button">
              <CheckCheck size={14} /> Marcar todo como leído
            </button>
          ) : null}
          <Link href="/app/account/notifications" className="btn btn-ghost btn-sm">
            <Settings size={14} /> Configurar
          </Link>
        </div>
      </div>

      {showPushBanner ? (
        <div className="notif-banner">
          <Smartphone size={18} />
          <div className="notif-banner-text">
            <strong>Recibe avisos en este dispositivo</strong>
            <span>
              {push.status === 'needs_install'
                ? 'En iPhone primero agrega UNIK a la pantalla de inicio (Compartir → “Agregar a inicio”) y ábrela desde ahí.'
                : 'Llamadas, mensajes y tareas de la IA te llegarán aunque la app esté cerrada.'}
            </span>
          </div>
          {push.status === 'prompt' ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void push.subscribe().then((ok) => ok && toast.success('Notificaciones activadas'))}
              disabled={push.busy}
            >
              <BellRing size={14} /> Activar
            </button>
          ) : (
            <Link href="/app/account/notifications" className="btn btn-secondary btn-sm">
              Cómo instalar
            </Link>
          )}
        </div>
      ) : null}

      <div className="notif-filters">
        <div className="notif-filter-group" role="tablist" aria-label="Filtro">
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'all'}
            className={`notif-chip ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            Todas
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'unread'}
            className={`notif-chip ${filter === 'unread' ? 'active' : ''}`}
            onClick={() => setFilter('unread')}
          >
            No leídas {unread > 0 ? <span className="notif-chip-count">{unread}</span> : null}
          </button>
        </div>
        <div className="notif-filter-group" aria-label="Tipo">
          <button
            type="button"
            className={`notif-chip ${group === null ? 'active' : ''}`}
            onClick={() => setGroup(null)}
          >
            Todo
          </button>
          {GROUPS.map((g) => (
            <button
              key={g}
              type="button"
              className={`notif-chip ${group === g ? 'active' : ''}`}
              onClick={() => setGroup(group === g ? null : g)}
            >
              {GROUP_ICONS[g]} {g}
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 0 }} aria-busy={loading}>
        {visible.length === 0 ? (
          <div className="empty-state">
            <Bell size={48} className="empty-state-icon" />
            <h3 className="empty-state-title">
              {filter === 'unread' ? 'Nada pendiente' : 'Sin notificaciones'}
            </h3>
            <p className="text-muted">
              Aquí verás llamadas, mensajes, avisos de la IA y cambios en lo que sigues.
            </p>
          </div>
        ) : (
          visible.map((n) => {
            const isUnread = n.readAt === null;
            return (
              <div
                key={n.id}
                className={`notif-item ${isUnread ? 'unread' : ''}`}
                role={n.url ? 'link' : undefined}
                tabIndex={0}
                onClick={() => void open(n)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void open(n);
                  }
                }}
              >
                <span className={`notif-item-icon notif-cat-${n.category}`} aria-hidden="true">
                  {iconFor(n.category)}
                </span>
                <div className="notif-item-body">
                  <div className="notif-item-title">
                    {isUnread ? <span className="so-unread-dot" /> : null}
                    {n.title}
                  </div>
                  {n.body ? <div className="notif-item-text">{n.body}</div> : null}
                  <div className="notif-item-meta">
                    <span>{relativeTime(n.createdAt)}</span>
                    {n.url ? <span className="notif-item-link">Abrir →</span> : null}
                  </div>
                </div>
                {isUnread ? (
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void markRead(n.id);
                    }}
                    aria-label="Marcar como leída"
                  >
                    <Check size={14} />
                  </button>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
