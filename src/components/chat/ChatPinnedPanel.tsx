'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Pin, X, Loader2 } from 'lucide-react';

export interface ChatPinnedPanelProps {
  channelId: string;
  onClose: () => void;
}

interface PinnedMessage {
  messageId: string;
  senderName: string;
  content: string;
  createdAt: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ChatPinnedPanel({ channelId, onClose }: ChatPinnedPanelProps) {
  const [pinned, setPinned] = useState<PinnedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPinned = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/app/chat/api/channels/${channelId}/pin`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error al cargar mensajes fijados');
      }
      const data = await res.json();
      setPinned(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    loadPinned();
  }, [loadPinned]);

  return (
    <div className="chat-dialog-overlay" onClick={onClose}>
      <div className="chat-dialog chat-pinned-panel" onClick={(e) => e.stopPropagation()}>
        <div className="chat-pinned-header">
          <h2>
            <Pin size={18} /> Mensajes fijados
          </h2>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>

        <div className="chat-pinned-list">
          {loading && (
            <div className="chat-panel-loading">
              <Loader2 size={20} className="spin" /> Cargando...
            </div>
          )}
          {error && <div className="chat-dialog-error">{error}</div>}
          {!loading && !error && pinned.length === 0 && (
            <div className="chat-dialog-empty">No hay mensajes fijados</div>
          )}
          {pinned.map((msg) => (
            <div key={msg.messageId} className="chat-pinned-item">
              <span className="chat-pinned-sender">{msg.senderName}</span>
              <span className="chat-pinned-preview">
                {msg.content?.slice(0, 200) ?? '[Archivo]'}
              </span>
              <span className="chat-pinned-date">{formatDate(msg.createdAt)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
