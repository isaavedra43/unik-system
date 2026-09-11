'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Phone, Video, PhoneOff } from 'lucide-react';

interface CallRow {
  id: string;
  channelId: string;
  channelName: string | null;
  callerId: string;
  callerName: string;
  type: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  participantCount: number;
}

const STATUS_TONE: Record<string, string> = {
  ringing: 'chat-admin-status-warning',
  active: 'chat-admin-status-success',
  ended: 'chat-admin-status-muted',
  missed: 'chat-admin-status-danger',
  declined: 'chat-admin-status-muted',
};

const STATUS_LABEL: Record<string, string> = {
  ringing: 'Sonando',
  active: 'Activa',
  ended: 'Finalizada',
  missed: 'Perdida',
  declined: 'Rechazada',
};

export function ChatAdminCalls() {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('');

  const load = useCallback(async () => {
    try {
      setError(null);
      const params = filter ? `?status=${filter}` : '';
      const res = await fetch(`/app/admin/chat/api/calls${params}`);
      if (res.ok) {
        const json = await res.json();
        setCalls(json.calls ?? []);
      } else {
        setError('No se pudieron cargar las llamadas');
      }
    } catch {
      setError('No se pudieron cargar las llamadas');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15_000);
    return () => clearInterval(interval);
  }, [load]);

  if (loading && calls.length === 0) return <div className="chat-admin-loading">Cargando…</div>;
  if (error) return <div className="chat-admin-error">{error}</div>;

  return (
    <div className="chat-admin-calls">
      <div className="chat-admin-filter-bar">
        <button type="button" className={`chat-admin-filter-btn ${filter === '' ? 'active' : ''}`} onClick={() => setFilter('')}>Todas</button>
        <button type="button" className={`chat-admin-filter-btn ${filter === 'ringing' ? 'active' : ''}`} onClick={() => setFilter('ringing')}>Sonando</button>
        <button type="button" className={`chat-admin-filter-btn ${filter === 'active' ? 'active' : ''}`} onClick={() => setFilter('active')}>Activas</button>
        <button type="button" className={`chat-admin-filter-btn ${filter === 'ended' ? 'active' : ''}`} onClick={() => setFilter('ended')}>Finalizadas</button>
        <button type="button" className={`chat-admin-filter-btn ${filter === 'missed' ? 'active' : ''}`} onClick={() => setFilter('missed')}>Perdidas</button>
      </div>

      <table className="chat-admin-table">
        <thead>
          <tr>
            <th>Tipo</th>
            <th>Canal</th>
            <th>Llamador</th>
            <th>Estado</th>
            <th>Participantes</th>
            <th>Inicio</th>
            <th>Fin</th>
            <th>Creada</th>
          </tr>
        </thead>
        <tbody>
          {calls.length === 0 && (
            <tr><td colSpan={8} className="chat-admin-empty">Sin llamadas</td></tr>
          )}
          {calls.map((c) => (
            <tr key={c.id}>
              <td>{c.type === 'video' ? <Video size={14} /> : <Phone size={14} />} {c.type}</td>
              <td>{c.channelName ?? c.channelId.slice(0, 8)}</td>
              <td>{c.callerName}</td>
              <td>
                <span className={`chat-admin-status ${STATUS_TONE[c.status] ?? 'chat-admin-status-muted'}`}>
                  {STATUS_LABEL[c.status] ?? c.status}
                </span>
              </td>
              <td>{c.participantCount}</td>
              <td>{c.startedAt ? new Date(c.startedAt).toLocaleString('es-MX') : '—'}</td>
              <td>{c.endedAt ? new Date(c.endedAt).toLocaleString('es-MX') : '—'}</td>
              <td>{new Date(c.createdAt).toLocaleString('es-MX')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
