'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Ban, CheckCircle } from 'lucide-react';

interface UserRow {
  userId: string;
  userName: string;
  username: string;
  email: string | null;
  messageCount: number;
  channelCount: number;
  attachmentCount: number;
  lastActivity: string | null;
}

export function ChatAdminUsers() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [suspendedIds, setSuspendedIds] = useState<Set<string>>(new Set());
  const [actioningId, setActioningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [usersRes, suspendedRes] = await Promise.all([
        fetch('/app/admin/chat/api/users'),
        fetch('/app/admin/chat/api/suspended-users'),
      ]);
      if (usersRes.ok) {
        const json = await usersRes.json();
        setUsers(json.users ?? []);
      } else {
        setError('No se pudieron cargar los usuarios');
      }
      if (suspendedRes.ok) {
        const sjson = await suspendedRes.json();
        setSuspendedIds(new Set(sjson.userIds ?? []));
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

  const handleToggleSuspend = async (userId: string, isSuspended: boolean) => {
    setActioningId(userId);
    try {
      const endpoint = isSuspended ? 'unsuspend' : 'suspend';
      const res = await fetch(`/app/admin/chat/api/users/${userId}/${endpoint}`, {
        method: 'POST',
      });
      if (res.ok) {
        setSuspendedIds((prev) => {
          const next = new Set(prev);
          if (isSuspended) next.delete(userId);
          else next.add(userId);
          return next;
        });
      }
    } catch {
      // silent
    } finally {
      setActioningId(null);
    }
  };

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
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {users.length === 0 && (
            <tr>
              <td colSpan={9} className="chat-admin-empty">
                Sin usuarios
              </td>
            </tr>
          )}
          {users.map((u) => {
            const isSuspended = suspendedIds.has(u.userId);
            return (
              <tr key={u.userId}>
                <td>{u.userName}</td>
                <td>{u.username}</td>
                <td>{u.email ?? '—'}</td>
                <td>{u.messageCount.toLocaleString('es-MX')}</td>
                <td>{u.channelCount}</td>
                <td>{u.attachmentCount}</td>
                <td>{u.lastActivity ? new Date(u.lastActivity).toLocaleString('es-MX') : '—'}</td>
                <td>
                  {isSuspended ? (
                    <span className="chat-admin-status chat-admin-status-danger">Suspendido</span>
                  ) : (
                    <span className="chat-admin-status chat-admin-status-success">Activo</span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className={`chat-admin-btn-sm ${isSuspended ? 'chat-admin-btn-secondary' : 'chat-admin-btn-danger'}`}
                    disabled={actioningId === u.userId}
                    onClick={() => handleToggleSuspend(u.userId, isSuspended)}
                    title={isSuspended ? 'Reactivar' : 'Suspender'}
                  >
                    {isSuspended ? <CheckCircle size={14} /> : <Ban size={14} />}
                    {actioningId === u.userId ? '…' : isSuspended ? 'Reactivar' : 'Suspender'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
