'use client';

import React, { useEffect, useState, useCallback } from 'react';

interface UserUsageRow {
  userId: string;
  userName: string;
  username: string;
  roleKeys: string[];
  messageCount: number;
  tokenCount: number;
  conversationCount: number;
  lastActivity: string | null;
}

export function AssistantAdminUsers() {
  const [data, setData] = useState<UserUsageRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/app/admin/assistant/api/users');
      if (res.ok) {
        const json = await res.json();
        setData(json.data ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="assistant-admin-tab">
      <div className="assistant-admin-table-wrap">
        {loading && <div className="assistant-admin-loading">Cargando…</div>}
        {!loading && data.length === 0 && <div className="assistant-admin-empty">No hay usuarios con uso del asistente</div>}
        {!loading && data.length > 0 && (
          <table className="assistant-admin-table">
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Roles</th>
                <th>Conversaciones</th>
                <th>Mensajes</th>
                <th>Tokens</th>
                <th>Última actividad</th>
              </tr>
            </thead>
            <tbody>
              {data.map((u) => (
                <tr key={u.userId}>
                  <td>{u.userName} <span className="assistant-admin-muted">@{u.username}</span></td>
                  <td>{u.roleKeys.join(', ') || '—'}</td>
                  <td>{u.conversationCount}</td>
                  <td>{u.messageCount}</td>
                  <td>{u.tokenCount.toLocaleString('es-MX')}</td>
                  <td>{u.lastActivity ? new Date(u.lastActivity).toLocaleString('es-MX') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
