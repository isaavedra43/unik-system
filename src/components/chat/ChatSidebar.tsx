'use client';

import React, { useState } from 'react';
import { Plus, Search, Users } from 'lucide-react';
import { ChatNewDialog } from './ChatNewDialog';
import type { ChatInboxItem } from '@/modules/chat/chat-events';

export interface ChatSidebarProps {
  activeId: string | null;
  inbox: ChatInboxItem[];
  onSelect: (id: string | null) => void;
  onChannelCreated: (id: string) => void;
}

export function ChatSidebar({ activeId, inbox, onSelect, onChannelCreated }: ChatSidebarProps) {
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);

  const filtered = search.trim()
    ? inbox.filter((item) => {
        const name = item.type === 'group' ? (item.name ?? '') : (item.otherUserName ?? '');
        return name.toLowerCase().includes(search.toLowerCase());
      })
    : inbox;

  const formatTime = (iso: string) => {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffMin < 1) return 'ahora';
    if (diffMin < 60) return `${diffMin}m`;
    if (diffHr < 24) return `${diffHr}h`;
    if (diffDay < 7) return `${diffDay}d`;
    return date.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
  };

  const getDisplayName = (item: ChatInboxItem) => {
    if (item.type === 'group') return item.name ?? 'Grupo';
    return item.otherUserName ?? 'Usuario';
  };

  const getInitials = (name: string) => {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  };

  return (
    <div className="chat-sidebar">
      <div className="chat-sidebar-header">
        <button type="button" className="chat-sidebar-new" onClick={() => setShowNew(true)}>
          <Plus size={16} />
          Nuevo chat
        </button>
        <div className="chat-sidebar-search">
          <Search size={16} />
          <input
            type="text"
            placeholder="Buscar conversación..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar conversación"
          />
        </div>
      </div>

      <div className="chat-sidebar-list">
        {filtered.length === 0 ? (
          <div className="chat-sidebar-empty">
            {search.trim() ? 'No se encontraron conversaciones' : 'No hay conversaciones aún'}
          </div>
        ) : (
          filtered.map((item) => {
            const name = getDisplayName(item);
            const isActive = item.channelId === activeId;
            return (
              <button
                key={item.channelId}
                type="button"
                className={`chat-sidebar-item ${isActive ? 'active' : ''}`}
                onClick={() => onSelect(item.channelId)}
              >
                <div className="chat-sidebar-avatar">
                  {item.type === 'group' ? <Users size={18} /> : <span>{getInitials(name)}</span>}
                  {item.type === 'dm' && item.otherUserStatus === 'online' && (
                    <span className="chat-sidebar-presence online" />
                  )}
                </div>
                <div className="chat-sidebar-content">
                  <div className="chat-sidebar-row">
                    <span className="chat-sidebar-name">{name}</span>
                    <span className="chat-sidebar-time">{formatTime(item.lastMessageAt)}</span>
                  </div>
                  <div className="chat-sidebar-row">
                    <span className="chat-sidebar-preview">
                      {item.lastMessagePreview ?? 'Sin mensajes'}
                    </span>
                    {item.unreadCount > 0 && (
                      <span className="chat-sidebar-badge">
                        {item.unreadCount > 99 ? '99+' : item.unreadCount}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>

      {showNew && (
        <ChatNewDialog
          onClose={() => setShowNew(false)}
          onChannelCreated={(id) => {
            onChannelCreated(id);
            setShowNew(false);
          }}
        />
      )}
    </div>
  );
}
