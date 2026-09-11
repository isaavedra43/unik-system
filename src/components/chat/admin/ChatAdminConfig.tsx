'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Save } from 'lucide-react';

export interface ChatAdminConfigProps {
  canManage: boolean;
}

interface ConfigEntry {
  key: string;
  value: string;
  description?: string;
}

export function ChatAdminConfig({ canManage }: ChatAdminConfigProps) {
  const [config, setConfig] = useState<ConfigEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editKey, setEditKey] = useState('');
  const [editValue, setEditValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null
  );

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/app/admin/chat/api/config');
      if (res.ok) {
        const json = await res.json();
        // API returns { config: Record<string, string> } — convert to array
        const configObj = json.config ?? {};
        const entries: ConfigEntry[] = Object.entries(configObj).map(([key, value]) => ({
          key,
          value: String(value),
        }));
        setConfig(entries);
      } else {
        setError('No se pudo cargar la configuración');
      }
    } catch {
      setError('No se pudo cargar la configuración');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleUpdate = async () => {
    if (!editKey.trim()) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await fetch('/app/admin/chat/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: editKey, value: editValue }),
      });
      if (res.ok) {
        setFeedback({ type: 'success', message: 'Configuración actualizada' });
        setEditKey('');
        setEditValue('');
        load();
      } else {
        setFeedback({ type: 'error', message: 'No se pudo actualizar la configuración' });
      }
    } catch {
      setFeedback({ type: 'error', message: 'No se pudo actualizar la configuración' });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="chat-admin-loading">Cargando…</div>;
  if (error) return <div className="chat-admin-error">{error}</div>;

  return (
    <div className="chat-admin-config">
      {feedback && (
        <div className={`chat-admin-feedback chat-admin-feedback-${feedback.type}`}>
          {feedback.message}
        </div>
      )}

      <table className="chat-admin-table">
        <thead>
          <tr>
            <th>Clave</th>
            <th>Valor</th>
            <th>Descripción</th>
          </tr>
        </thead>
        <tbody>
          {config.length === 0 && (
            <tr>
              <td colSpan={3} className="chat-admin-empty">
                Sin configuración
              </td>
            </tr>
          )}
          {config.map((c) => (
            <tr key={c.key}>
              <td className="chat-admin-config-key">{c.key}</td>
              <td className="chat-admin-config-value">{c.value}</td>
              <td className="chat-admin-config-desc">{c.description ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {canManage && (
        <div className="chat-admin-config-form">
          <h3 className="chat-admin-section-title">Actualizar valor</h3>
          <div className="chat-admin-form-row">
            <input
              type="text"
              placeholder="Clave"
              value={editKey}
              onChange={(e) => setEditKey(e.target.value)}
              disabled={submitting}
            />
            <input
              type="text"
              placeholder="Valor"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              disabled={submitting}
            />
            <button
              type="button"
              className="chat-admin-btn-primary"
              disabled={!editKey.trim() || submitting}
              onClick={handleUpdate}
            >
              <Save size={16} />
              Guardar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
