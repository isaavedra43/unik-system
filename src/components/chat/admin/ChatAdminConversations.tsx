'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { ArrowLeft, MessageSquare, Download } from 'lucide-react';

interface Channel {
  id: string;
  type: string;
  name: string | null;
  createdBy: string;
  memberCount: number;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

interface Message {
  id: string;
  senderId: string;
  senderName: string;
  content: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export function ChatAdminConversations() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);

  const loadChannels = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/app/admin/chat/api/conversations');
      if (res.ok) {
        const json = await res.json();
        setChannels(json.channels ?? []);
      } else {
        setError('No se pudieron cargar las conversaciones');
      }
    } catch {
      setError('No se pudieron cargar las conversaciones');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMessages = useCallback(async (channelId: string) => {
    setMessagesLoading(true);
    setMessagesError(null);
    try {
      const res = await fetch(`/app/admin/chat/api/conversations/${channelId}`);
      if (res.ok) {
        const json = await res.json();
        setMessages(json.messages ?? []);
      } else {
        setMessagesError('No se pudieron cargar los mensajes');
      }
    } catch {
      setMessagesError('No se pudieron cargar los mensajes');
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  const handleSelectChannel = (channel: Channel) => {
    setSelectedChannel(channel);
    loadMessages(channel.id);
  };

  const handleBack = () => {
    setSelectedChannel(null);
    setMessages([]);
  };

  const handleExport = (format: 'csv' | 'json') => {
    if (!selectedChannel) return;
    window.open(`/app/admin/chat/api/conversations/${selectedChannel.id}/export?format=${format}`, '_blank');
  };

  if (loading) return <div className="chat-admin-loading">Cargando…</div>;
  if (error) return <div className="chat-admin-error">{error}</div>;

  if (selectedChannel) {
    return (
      <div className="chat-admin-conversation-detail">
        <button type="button" className="chat-admin-back-btn" onClick={handleBack}>
          <ArrowLeft size={16} />
          Volver a conversaciones
        </button>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <h3 className="chat-admin-section-title">
            #{selectedChannel.name ?? 'sin-nombre'}{' '}
            <span className="chat-admin-channel-type">({selectedChannel.type})</span>
          </h3>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="chat-admin-btn-secondary chat-admin-btn-sm" onClick={() => handleExport('csv')}>
              <Download size={14} /> CSV
            </button>
            <button type="button" className="chat-admin-btn-secondary chat-admin-btn-sm" onClick={() => handleExport('json')}>
              <Download size={14} /> JSON
            </button>
          </div>
        </div>
        {messagesLoading && <div className="chat-admin-loading">Cargando mensajes…</div>}
        {messagesError && <div className="chat-admin-error">{messagesError}</div>}
        {!messagesLoading && !messagesError && (
          <div className="chat-admin-message-list">
            {messages.length === 0 && <div className="chat-admin-empty">Sin mensajes</div>}
            {messages.map((m) => (
              <div key={m.id} className="chat-admin-message-item">
                <div className="chat-admin-message-sender">{m.senderName}</div>
                <div className="chat-admin-message-content">
                  {m.deletedAt ? <em style={{ color: 'var(--unik-text-muted)' }}>[eliminado]</em> : (m.content ?? '—')}
                </div>
                <div className="chat-admin-message-date">
                  {new Date(m.createdAt).toLocaleString('es-MX')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="chat-admin-conversations">
      <table className="chat-admin-table">
        <thead>
          <tr>
            <th>Tipo</th>
            <th>Nombre</th>
            <th>Miembros</th>
            <th>Mensajes</th>
            <th>Último mensaje</th>
          </tr>
        </thead>
        <tbody>
          {channels.length === 0 && (
            <tr>
              <td colSpan={5} className="chat-admin-empty">
                Sin conversaciones
              </td>
            </tr>
          )}
          {channels.map((c) => (
            <tr
              key={c.id}
              className="chat-admin-row-clickable"
              onClick={() => handleSelectChannel(c)}
            >
              <td>{c.type}</td>
              <td>
                <MessageSquare size={14} /> {c.name ?? '—'}
              </td>
              <td>{c.memberCount}</td>
              <td>{c.messageCount.toLocaleString('es-MX')}</td>
              <td>{new Date(c.lastMessageAt).toLocaleString('es-MX')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
