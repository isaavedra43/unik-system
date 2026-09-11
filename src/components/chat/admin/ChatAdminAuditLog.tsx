'use client';

import React, { useEffect, useState, useCallback } from 'react';

interface AuditEntry {
  id: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: unknown;
  createdAt: string;
}

const ACTION_LABELS: Record<string, string> = {
  'chat.admin.delete_message': 'Eliminar mensaje',
  'chat.admin.delete_channel': 'Eliminar canal',
  'chat.admin.resolve_alert': 'Resolver alerta',
  'chat.admin.update_config': 'Actualizar config',
  'chat.admin.suspend_user': 'Suspender usuario',
  'chat.admin.unsuspend_user': 'Reactivar usuario',
  'chat.admin.broadcast': 'Anuncio global',
  'chat.call_initiated': 'Iniciar llamada',
};

export function ChatAdminAuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    try {
      setError(null);
      const params = filter ? `?action=${filter}` : '';
      const res = await fetch(`/app/admin/chat/api/audit${params}`);
      if (res.ok) {
        const json = await res.json();
        setEntries(json.entries ?? []);
      } else {
        setError('No se pudo cargar el log de auditoría');
      }
    } catch {
      setError('No se pudo cargar el log de auditoría');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <div className="chat-admin-loading">Cargando…</div>;
  if (error) return <div className="chat-admin-error">{error}</div>;

  return (
    <div className="chat-admin-audit">
      <div className="chat-admin-filter-bar">
        <button type="button" className={`chat-admin-filter-btn ${filter === '' ? 'active' : ''}`} onClick={() => setFilter('')}>Todo</button>
        <button type="button" className={`chat-admin-filter-btn ${filter === 'chat.admin' ? 'active' : ''}`} onClick={() => setFilter('chat.admin')}>Admin</button>
        <button type="button" className={`chat-admin-filter-btn ${filter === 'chat.call' ? 'active' : ''}`} onClick={() => setFilter('chat.call')}>Llamadas</button>
      </div>

      <table className="chat-admin-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Usuario</th>
            <th>Acción</th>
            <th>Objetivo</th>
            <th>ID</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr><td colSpan={5} className="chat-admin-empty">Sin registros</td></tr>
          )}
          {entries.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.createdAt).toLocaleString('es-MX')}</td>
              <td>{e.actorName ?? e.actorUserId ?? 'Sistema'}</td>
              <td>{ACTION_LABELS[e.action] ?? e.action}</td>
              <td>{e.targetType}</td>
              <td style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{e.targetId ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
