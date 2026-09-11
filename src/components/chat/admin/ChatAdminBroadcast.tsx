'use client';

import React, { useState } from 'react';
import { Megaphone, Send } from 'lucide-react';

export interface ChatAdminBroadcastProps {
  canManage: boolean;
}

export function ChatAdminBroadcast({ canManage }: ChatAdminBroadcastProps) {
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const handleSend = async () => {
    if (!message.trim()) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await fetch('/app/admin/chat/api/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (res.ok) {
        const data = await res.json();
        setFeedback({ type: 'success', message: `Anuncio enviado a ${data.sentCount} canales` });
        setMessage('');
      } else {
        const data = await res.json().catch(() => ({}));
        setFeedback({ type: 'error', message: data.error ?? 'Error al enviar anuncio' });
      }
    } catch {
      setFeedback({ type: 'error', message: 'Error al enviar anuncio' });
    } finally {
      setSubmitting(false);
    }
  };

  if (!canManage) {
    return <div className="chat-admin-error">No tienes permisos para enviar anuncios</div>;
  }

  return (
    <div className="chat-admin-broadcast">
      {feedback && (
        <div className={`chat-admin-feedback chat-admin-feedback-${feedback.type}`}>
          {feedback.message}
        </div>
      )}

      <div className="chat-admin-broadcast-form">
        <h3 className="chat-admin-section-title">
          <Megaphone size={18} /> Anuncio global
        </h3>
        <p className="chat-admin-broadcast-hint">
          El mensaje se enviará como un mensaje urgente a todos los canales grupales del chat.
        </p>
        <textarea
          className="chat-admin-broadcast-textarea"
          placeholder="Escribe el anuncio…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          maxLength={2000}
          disabled={submitting}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.75rem' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)' }}>
            {message.length}/2000 caracteres
          </span>
          <button
            type="button"
            className="chat-admin-btn-primary"
            disabled={!message.trim() || submitting}
            onClick={handleSend}
          >
            <Send size={16} />
            {submitting ? 'Enviando…' : 'Enviar anuncio'}
          </button>
        </div>
      </div>
    </div>
  );
}
