'use client';

import { useState } from 'react';
import { Check, Bell } from 'lucide-react';
import { toast } from 'sonner';
import {
  markNotificationReadAction,
  markAllNotificationsReadAction,
} from '@/app/app/sales/orders/actions';
import { NotificationRow } from '@/modules/sales/notifications-service';

interface NotificationsPageProps {
  initialData: { data: NotificationRow[]; total: number; unread: number };
}

function formatDateTime(value: string): string {
  try {
    return new Date(value).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return value;
  }
}

export function NotificationsPage({ initialData }: NotificationsPageProps) {
  const [notifications, setNotifications] = useState(initialData.data);
  const [unread, setUnread] = useState(initialData.unread);

  const handleMarkRead = async (id: string) => {
    const formData = new FormData();
    formData.set('notificationId', id);
    const result = await markNotificationReadAction({ error: null, success: false }, formData);
    if (result.success) {
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n))
      );
      setUnread((u) => Math.max(0, u - 1));
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  const handleMarkAllRead = async () => {
    const result = await markAllNotificationsReadAction();
    if (result.success) {
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() }))
      );
      setUnread(0);
      toast.success('Todas las notificaciones marcadas como leídas');
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  return (
    <div>
      <div className="page-header page-header-row">
        <div className="page-header-info">
          <h1 className="page-title">Notificaciones</h1>
          <p className="page-description">{unread > 0 ? `${unread} sin leer` : 'Todo al día'}</p>
        </div>
        {unread > 0 ? (
          <div className="row-actions">
            <button className="btn btn-secondary btn-sm" onClick={handleMarkAllRead}>
              <Check size={14} /> Marcar todo como leído
            </button>
          </div>
        ) : null}
      </div>

      <div className="card" style={{ padding: 0 }}>
        {notifications.length === 0 ? (
          <div className="empty-state">
            <Bell size={48} className="empty-state-icon" />
            <h3 className="empty-state-title">Sin notificaciones</h3>
            <p className="text-muted">Cuando sigas órdenes de venta, aquí verás sus cambios.</p>
          </div>
        ) : (
          notifications.map((n) => {
            const isUnread = n.readAt === null;
            return (
              <div
                key={n.id}
                className={`so-notification-item ${isUnread ? 'unread' : ''}`}
                onClick={() => isUnread && handleMarkRead(n.id)}
                style={{ borderBottom: '1px solid var(--unik-border-subtle)' }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                  {isUnread ? (
                    <span className="so-unread-dot" style={{ marginTop: '6px' }} />
                  ) : null}
                  <div style={{ flex: 1 }}>
                    <div className="so-notification-title">{n.title}</div>
                    {n.body ? <div className="so-notification-body">{n.body}</div> : null}
                    <div className="so-notification-time">{formatDateTime(n.createdAt)}</div>
                  </div>
                  {isUnread ? (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMarkRead(n.id);
                      }}
                      aria-label="Marcar como leída"
                    >
                      <Check size={14} />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
