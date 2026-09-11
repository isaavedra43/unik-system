'use client';

import React, { useState } from 'react';
import { Trash2, AlertTriangle } from 'lucide-react';

export interface ChatAdminModerationProps {
  canManage: boolean;
}

export function ChatAdminModeration({ canManage }: ChatAdminModerationProps) {
  const [messageId, setMessageId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmAction, setConfirmAction] = useState<null | 'delete_message' | 'delete_channel'>(
    null
  );
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null
  );

  const handleDeleteMessage = async () => {
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await fetch('/app/admin/chat/api/moderation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete_message', targetId: messageId }),
      });
      if (res.ok) {
        setFeedback({ type: 'success', message: 'Mensaje eliminado' });
        setMessageId('');
      } else {
        setFeedback({ type: 'error', message: 'No se pudo eliminar el mensaje' });
      }
    } catch {
      setFeedback({ type: 'error', message: 'No se pudo eliminar el mensaje' });
    } finally {
      setSubmitting(false);
      setConfirmAction(null);
    }
  };

  const handleDeleteChannel = async () => {
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await fetch('/app/admin/chat/api/moderation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete_channel', targetId: channelId }),
      });
      if (res.ok) {
        setFeedback({ type: 'success', message: 'Canal eliminado' });
        setChannelId('');
      } else {
        setFeedback({ type: 'error', message: 'No se pudo eliminar el canal' });
      }
    } catch {
      setFeedback({ type: 'error', message: 'No se pudo eliminar el canal' });
    } finally {
      setSubmitting(false);
      setConfirmAction(null);
    }
  };

  if (!canManage) {
    return <div className="chat-admin-error">No tienes permisos para moderar</div>;
  }

  return (
    <div className="chat-admin-moderation">
      {feedback && (
        <div className={`chat-admin-feedback chat-admin-feedback-${feedback.type}`}>
          {feedback.message}
        </div>
      )}

      <div className="chat-admin-moderation-form">
        <h3 className="chat-admin-section-title">Eliminar mensaje</h3>
        <div className="chat-admin-form-row">
          <input
            type="text"
            placeholder="ID del mensaje"
            value={messageId}
            onChange={(e) => setMessageId(e.target.value)}
            disabled={submitting}
          />
          <button
            type="button"
            className="chat-admin-btn-danger"
            disabled={!messageId.trim() || submitting}
            onClick={() => setConfirmAction('delete_message')}
          >
            <Trash2 size={16} />
            Eliminar
          </button>
        </div>
      </div>

      <div className="chat-admin-moderation-form">
        <h3 className="chat-admin-section-title">Eliminar canal</h3>
        <div className="chat-admin-form-row">
          <input
            type="text"
            placeholder="ID del canal"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            disabled={submitting}
          />
          <button
            type="button"
            className="chat-admin-btn-danger"
            disabled={!channelId.trim() || submitting}
            onClick={() => setConfirmAction('delete_channel')}
          >
            <Trash2 size={16} />
            Eliminar
          </button>
        </div>
      </div>

      {confirmAction && (
        <div className="chat-admin-confirm-overlay">
          <div className="chat-admin-confirm-dialog">
            <AlertTriangle size={24} />
            <p>
              {confirmAction === 'delete_message'
                ? '¿Seguro que deseas eliminar este mensaje?'
                : '¿Seguro que deseas eliminar este canal? Esta acción no se puede deshacer.'}
            </p>
            <div className="chat-admin-confirm-actions">
              <button
                type="button"
                className="chat-admin-btn-secondary"
                onClick={() => setConfirmAction(null)}
                disabled={submitting}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="chat-admin-btn-danger"
                onClick={
                  confirmAction === 'delete_message' ? handleDeleteMessage : handleDeleteChannel
                }
                disabled={submitting}
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
