'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { CheckCircle, AlertTriangle } from 'lucide-react';

export interface ChatAdminAlertsProps {
  canManage: boolean;
}

interface Alert {
  id: string;
  type: string;
  severity: string;
  userId: string | null;
  channelId: string | null;
  messageId: string | null;
  metadata: { keyword?: string; preview?: string; links?: string[]; emails?: string[]; hour?: number; count?: number; window?: string } | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
}

export function ChatAdminAlerts({ canManage }: ChatAdminAlertsProps) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'unresolved' | 'resolved' | 'all'>('unresolved');
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/app/admin/chat/api/alerts');
      if (res.ok) {
        const json = await res.json();
        setAlerts(json.alerts ?? []);
      } else {
        setError('No se pudieron cargar las alertas');
      }
    } catch {
      setError('No se pudieron cargar las alertas');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 20_000);
    return () => clearInterval(interval);
  }, [load]);

  const handleResolve = async (alertId: string) => {
    setResolvingId(alertId);
    try {
      const res = await fetch('/app/admin/chat/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId }),
      });
      if (res.ok) {
        setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, resolvedAt: new Date().toISOString() } : a)));
      }
    } catch {
      // ignore
    } finally {
      setResolvingId(null);
    }
  };

  const filtered = alerts.filter((a) => {
    if (filter === 'all') return true;
    if (filter === 'resolved') return a.resolvedAt !== null;
    return a.resolvedAt === null;
  });

  if (loading) return <div className="chat-admin-loading">Cargando…</div>;
  if (error) return <div className="chat-admin-error">{error}</div>;

  return (
    <div className="chat-admin-alerts">
      <div className="chat-admin-filter-bar">
        <button
          type="button"
          className={`chat-admin-filter-btn ${filter === 'unresolved' ? 'active' : ''}`}
          onClick={() => setFilter('unresolved')}
        >
          Sin resolver
        </button>
        <button
          type="button"
          className={`chat-admin-filter-btn ${filter === 'resolved' ? 'active' : ''}`}
          onClick={() => setFilter('resolved')}
        >
          Resueltas
        </button>
        <button
          type="button"
          className={`chat-admin-filter-btn ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          Todas
        </button>
      </div>

      <div className="chat-admin-alert-list">
        {filtered.length === 0 && <div className="chat-admin-empty">Sin alertas</div>}
        {filtered.map((a) => (
          <div
            key={a.id}
            className={`chat-admin-alert chat-admin-alert-${a.severity} ${a.resolvedAt ? 'resolved' : ''}`}
          >
            <div className="chat-admin-alert-icon">
              <AlertTriangle size={18} />
            </div>
            <div className="chat-admin-alert-body">
              <div className="chat-admin-alert-type">{a.type}</div>
              <div className="chat-admin-alert-meta">
                <span>{a.userId ?? '—'}</span>
                <span>#{a.channelId ?? '—'}</span>
                <span>{new Date(a.createdAt).toLocaleString('es-MX')}</span>
              </div>
            </div>
            <div className="chat-admin-alert-actions">
              {a.resolvedAt ? (
                <span className="chat-admin-alert-resolved">
                  <CheckCircle size={16} /> Resuelta
                </span>
              ) : canManage ? (
                <button
                  type="button"
                  className="chat-admin-btn-secondary"
                  disabled={resolvingId === a.id}
                  onClick={() => handleResolve(a.id)}
                >
                  {resolvingId === a.id ? 'Resolviendo…' : 'Resolver'}
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
