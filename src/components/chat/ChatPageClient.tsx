'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Menu, X } from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import { ChatSidebar } from './ChatSidebar';
import { ChatConversation } from './ChatConversation';
import { ChatEmptyState } from './ChatEmptyState';
import type { ChatInboxItem } from '@/modules/chat/chat-events';

export interface ChatPageClientProps {
  user: CurrentUser;
}

export function ChatPageClient({ user }: ChatPageClientProps) {
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inbox, setInbox] = useState<ChatInboxItem[]>([]);
  const [totalUnread, setTotalUnread] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  const refreshInbox = useCallback(async () => {
    try {
      const res = await fetch('/app/chat/api/inbox');
      if (res.ok) {
        const json = await res.json();
        setInbox(json.data);
        setTotalUnread(json.totalUnread);
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    refreshInbox();
    const interval = setInterval(refreshInbox, 10_000);
    return () => clearInterval(interval);
  }, [refreshInbox, refreshKey]);

  // Presence heartbeat
  useEffect(() => {
    const heartbeat = () => {
      fetch('/app/chat/api/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'online' }),
      }).catch(() => {});
    };
    heartbeat();
    const interval = setInterval(heartbeat, 30_000);

    const onVisibilityChange = () => {
      if (document.hidden) {
        fetch('/app/chat/api/presence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'away' }),
        }).catch(() => {});
      } else {
        heartbeat();
      }
    };

    const onBeforeUnload = () => {
      fetch('/app/chat/api/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'offline' }),
      }).catch(() => {});
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('beforeunload', onBeforeUnload);
      onBeforeUnload();
    };
  }, []);

  const handleSelectChannel = (id: string | null) => {
    setActiveChannelId(id);
    setSidebarOpen(false);
    if (id) {
      // Mark as read
      fetch(`/app/chat/api/channels/${id}/read`, { method: 'POST' }).catch(() => {});
    }
  };

  const handleChannelCreated = (id: string) => {
    setActiveChannelId(id);
    setSidebarOpen(false);
    setRefreshKey((k) => k + 1);
  };

  const handleRefresh = () => {
    setRefreshKey((k) => k + 1);
  };

  const handleBack = () => {
    setActiveChannelId(null);
  };

  return (
    <div className="chat-page">
      {/* Mobile sidebar toggle (outside body so it sits on top) */}
      <button
        type="button"
        className="chat-sidebar-toggle"
        onClick={() => setSidebarOpen(true)}
        aria-label="Ver conversaciones"
      >
        <Menu size={18} />
        <span>Conversaciones</span>
        {totalUnread > 0 && (
          <span className="chat-sidebar-toggle-badge">
            {totalUnread > 99 ? '99+' : totalUnread}
          </span>
        )}
      </button>

      <div className="chat-page-body">
        {/* Mobile backdrop */}
        {sidebarOpen && (
          <div
            className="chat-sidebar-backdrop"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Sidebar */}
        <div className={`chat-sidebar-wrapper ${sidebarOpen ? 'open' : ''}`}>
          <div className="chat-sidebar-header-mobile">
            <span>Conversaciones</span>
            <button type="button" onClick={() => setSidebarOpen(false)} aria-label="Cerrar">
              <X size={20} />
            </button>
          </div>
          <ChatSidebar
            activeId={activeChannelId}
            inbox={inbox}
            onSelect={handleSelectChannel}
            onChannelCreated={handleChannelCreated}
          />
        </div>

        {/* Main conversation area */}
        <div className="chat-page-main">
          {activeChannelId ? (
            <ChatConversation
              channelId={activeChannelId}
              user={user}
              onRefresh={handleRefresh}
              onBack={handleBack}
            />
          ) : (
            <ChatEmptyState onNewChat={() => setSidebarOpen(true)} />
          )}
        </div>
      </div>
    </div>
  );
}
