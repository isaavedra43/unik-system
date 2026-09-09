'use client';

import React, { useEffect, useState, useCallback } from 'react';

interface UserRow {
  id: string;
  name: string;
  username: string;
  email: string;
  messageCount: number;
  channelCount: number;
  attachments: number;
  lastActivity: string | null;
}

export function ChatAdminUsers() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/app/admin/chat/api/users');
      if (res.ok) {
        const json = await res.json();
        setUsers(json.users ?? []);
      } else {
        setError('No se pudieron cargar los usuarios');
      }
    } catch {
      setError('No se pudieron cargar los usuarios');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <div className="chat-admin-loading">Cargando…</div>;
  if (error) return <div className="chat-admin-error">{error}</div>;

  return (
    <div className="chat-admin-users">
      <table className="chat-admin-table">
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Usuario</th>
            <th>Email</th>
            <th>Mensajes</th>
            <th>Canales</th>
            <th>Adjuntos</th>
            <th>Última actividad</th>
          </tr>
        </thead>
        <tbody>
          {users.length === 0 && (
            <tr>
              <td colSpan={7} className="chat-admin-empty">
                Sin usuarios
              </td>
            </tr>
          )}
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.username}</td>
              <td>{u.email}</td>
              <td>{u.messageCount.toLocaleString('es-MX')}</td>
              <td>{u.channelCount}</td>
              <td>{u.attachments}</td>
              <td>{u.lastActivity ? new Date(u.lastActivity).toLocaleString('es-MX') : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
