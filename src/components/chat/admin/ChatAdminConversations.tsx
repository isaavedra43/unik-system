'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { ArrowLeft, MessageSquare } from 'lucide-react';

interface Channel {
  id: string;
  type: string;
  name: string;
  members: number;
  messages: number;
  lastMessage: string | null;
  lastMessageAt: string | null;
}

interface Message {
  id: string;
  sender: string;
  content: string;
  createdAt: string;
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

  if (loading) return <div className="chat-admin-loading">Cargando…</div>;
  if (error) return <div className="chat-admin-error">{error}</div>;

  if (selectedChannel) {
    return (
      <div className="chat-admin-conversation-detail">
        <button type="button" className="chat-admin-back-btn" onClick={handleBack}>
          <ArrowLeft size={16} />
          Volver a conversaciones
        </button>
        <h3 className="chat-admin-section-title">
          #{selectedChannel.name}{' '}
          <span className="chat-admin-channel-type">({selectedChannel.type})</span>
        </h3>
        {messagesLoading && <div className="chat-admin-loading">Cargando mensajes…</div>}
        {messagesError && <div className="chat-admin-error">{messagesError}</div>}
        {!messagesLoading && !messagesError && (
          <div className="chat-admin-message-list">
            {messages.length === 0 && <div className="chat-admin-empty">Sin mensajes</div>}
            {messages.map((m) => (
              <div key={m.id} className="chat-admin-message-item">
                <div className="chat-admin-message-sender">{m.sender}</div>
                <div className="chat-admin-message-content">{m.content}</div>
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
                <MessageSquare size={14} /> {c.name}
              </td>
              <td>{c.members}</td>
              <td>{c.messages.toLocaleString('es-MX')}</td>
              <td>
                {c.lastMessage
                  ? new Date(c.lastMessageAt ?? c.lastMessage).toLocaleString('es-MX')
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
