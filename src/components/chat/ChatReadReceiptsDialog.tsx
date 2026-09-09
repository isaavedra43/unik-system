'use client';

import React, { useState, useEffect } from 'react';
import { X, CheckCheck, Loader2 } from 'lucide-react';

export interface ChatReadReceiptsDialogProps {
  messageId: string;
  onClose: () => void;
}

interface Reader {
  userId: string;
  name: string;
  readAt: string;
}

export function ChatReadReceiptsDialog({ messageId, onClose }: ChatReadReceiptsDialogProps) {
  const [readers, setReaders] = useState<Reader[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/app/chat/api/messages/${messageId}/readers`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Error al cargar lecturas');
        }
        const data = await res.json();
        if (!cancelled) setReaders(data.data ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Error desconocido');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleString('es-MX', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="chat-dialog-overlay" onClick={onClose}>
      <div className="chat-read-receipts" onClick={(e) => e.stopPropagation()}>
        <div className="chat-dialog-header">
          <h2>
            <CheckCheck size={20} /> Leído por
          </h2>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>
        <div className="chat-read-receipts-list">
          {loading && (
            <div className="chat-panel-loading">
              <Loader2 size={20} className="spin" /> Cargando...
            </div>
          )}
          {error && <div className="chat-dialog-error">{error}</div>}
          {!loading && !error && readers.length === 0 && (
            <div className="chat-dialog-empty">Nadie ha leído este mensaje todavía</div>
          )}
          {readers.map((r) => (
            <div key={r.userId} className="chat-read-receipt-item">
              <div className="chat-read-receipt-avatar">{r.name.slice(0, 2).toUpperCase()}</div>
              <div className="chat-read-receipt-info">
                <div className="chat-read-receipt-name">{r.name}</div>
                <div className="chat-read-receipt-time">Leído a las {formatTime(r.readAt)}</div>
              </div>
              <CheckCheck size={16} className="chat-read-receipt-icon" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
