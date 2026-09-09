'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { X, CornerUpRight, Send, Loader2 } from 'lucide-react';
import type { ChatMessageDTO } from '@/modules/chat/chat-events';
import type { CurrentUser } from '@/modules/auth/authorization';

export interface ChatThreadPanelProps {
  threadId: string;
  rootMessage: ChatMessageDTO;
  channelId: string;
  user: CurrentUser;
  onClose: () => void;
}

export function ChatThreadPanel({
  threadId,
  rootMessage,
  channelId,
  user,
  onClose,
}: ChatThreadPanelProps) {
  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/app/chat/api/threads/${threadId}/messages`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error al cargar el hilo');
      }
      const data = await res.json();
      setMessages(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      const res = await fetch(`/app/chat/api/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: trimmed,
          replyToId: rootMessage.id,
          threadId,
        }),
      });
      if (res.ok) {
        const msg = await res.json();
        setMessages((prev) => [...prev, msg]);
        setText('');
      }
    } catch {
      // silent
    } finally {
      setSending(false);
    }
  }, [text, channelId, rootMessage.id, threadId]);

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="chat-thread-panel">
      <div className="chat-thread-header">
        <div className="chat-thread-title">
          <CornerUpRight size={18} />
          <span>Hilo de conversación</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Cerrar hilo">
          <X size={18} />
        </button>
      </div>

      {/* Root message */}
      <div className="chat-thread-root">
        <div className="chat-thread-root-sender">{rootMessage.senderName}</div>
        <div className="chat-thread-root-content">{rootMessage.content ?? '[Archivo]'}</div>
        <div className="chat-thread-root-time">{formatTime(rootMessage.createdAt)}</div>
      </div>

      {/* Thread messages */}
      <div className="chat-thread-messages">
        {loading && (
          <div className="chat-panel-loading">
            <Loader2 size={20} className="spin" /> Cargando...
          </div>
        )}
        {error && <div className="chat-dialog-error">{error}</div>}
        {!loading && !error && messages.length === 0 && (
          <div className="chat-thread-empty">No hay respuestas en este hilo todavía</div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-thread-msg ${msg.senderId === user.id ? 'own' : ''}`}>
            <div className="chat-thread-msg-sender">{msg.senderName}</div>
            <div className="chat-thread-msg-content">{msg.content}</div>
            <div className="chat-thread-msg-time">{formatTime(msg.createdAt)}</div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="chat-thread-input">
        <input
          type="text"
          placeholder="Responder en el hilo..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          aria-label="Responder en hilo"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={sending || !text.trim()}
          aria-label="Enviar"
        >
          {sending ? <Loader2 size={18} className="spin" /> : <Send size={18} />}
        </button>
      </div>
    </div>
  );
}
