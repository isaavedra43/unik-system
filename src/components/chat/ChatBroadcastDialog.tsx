'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { X, Send, Loader2, Megaphone, AlertCircle, Check } from 'lucide-react';

interface Channel {
  id: string;
  name: string;
  type: string;
}

export interface ChatBroadcastDialogProps {
  onClose: () => void;
  onSent: () => void;
}

export function ChatBroadcastDialog({ onClose, onSent }: ChatBroadcastDialogProps) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [content, setContent] = useState('');
  const [priority, setPriority] = useState<'normal' | 'urgent'>('normal');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/app/chat/api/channels');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setChannels(data.data ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 5) next.add(id);
      return next;
    });
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || selected.size === 0) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/app/chat/api/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelIds: Array.from(selected),
          content: trimmed,
          priority,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error al difundir');
      }
      onSent();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setSending(false);
    }
  }, [content, selected, priority, onSent, onClose]);

  return (
    <div className="chat-dialog-overlay" onClick={onClose}>
      <div className="chat-broadcast-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="chat-dialog-header">
          <h2>
            <Megaphone size={20} /> Difundir a canales
          </h2>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>

        <div className="chat-broadcast-body">
          <div className="chat-broadcast-section">
            <label className="chat-broadcast-label">Selecciona canales ({selected.size}/5)</label>
            {loading ? (
              <div className="chat-panel-loading">
                <Loader2 size={20} className="spin" /> Cargando...
              </div>
            ) : (
              <div className="chat-broadcast-channels">
                {channels.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`chat-broadcast-channel ${selected.has(c.id) ? 'selected' : ''}`}
                    onClick={() => toggle(c.id)}
                  >
                    <div className="chat-dialog-user-avatar">
                      {c.type === 'group' ? '👥' : c.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="chat-dialog-user-info">
                      <div className="chat-dialog-user-name">{c.name}</div>
                    </div>
                    {selected.has(c.id) && <Check size={18} className="chat-dialog-check" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="chat-broadcast-section">
            <label className="chat-broadcast-label">Mensaje</label>
            <textarea
              className="chat-broadcast-textarea"
              placeholder="Escribe el mensaje a difundir..."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={4}
              maxLength={10000}
              aria-label="Mensaje a difundir"
            />
            <div className="chat-broadcast-char-count">{content.length}/10000</div>
          </div>

          <div className="chat-broadcast-section">
            <label className="chat-broadcast-label">Prioridad</label>
            <div className="chat-broadcast-priority">
              <button
                type="button"
                className={`chat-broadcast-priority-btn ${priority === 'normal' ? 'active' : ''}`}
                onClick={() => setPriority('normal')}
              >
                Normal
              </button>
              <button
                type="button"
                className={`chat-broadcast-priority-btn ${priority === 'urgent' ? 'active urgent' : ''}`}
                onClick={() => setPriority('urgent')}
              >
                <AlertCircle size={14} /> Urgente
              </button>
            </div>
          </div>

          {error && <div className="chat-dialog-error">{error}</div>}
        </div>

        <div className="chat-dialog-footer">
          <button type="button" className="chat-dialog-cancel" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="chat-dialog-create"
            disabled={sending || selected.size === 0 || !content.trim()}
            onClick={handleSend}
          >
            {sending ? (
              <>
                <Loader2 size={16} className="spin" /> Difundiendo...
              </>
            ) : (
              <>
                <Send size={16} /> Difundir{selected.size > 0 ? ` (${selected.size})` : ''}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
