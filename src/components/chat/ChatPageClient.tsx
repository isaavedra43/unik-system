'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Menu, X, Search, Bookmark, Pin, Calendar } from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import { ChatSidebar } from './ChatSidebar';
import { ChatConversation } from './ChatConversation';
import { ChatEmptyState } from './ChatEmptyState';
import { ChatSearchDialog } from './ChatSearchDialog';
import { ChatBookmarksPanel } from './ChatBookmarksPanel';
import { ChatPinnedPanel } from './ChatPinnedPanel';
import { ChatCalendarView } from './ChatCalendarView';
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
  const [showSearch, setShowSearch] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showPinned, setShowPinned] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);

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
      <div className="chat-topbar">
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

        <div className="chat-topbar-actions">
          <button
            type="button"
            className="chat-topbar-btn"
            onClick={() => setShowSearch(true)}
            aria-label="Buscar mensajes"
          >
            <Search size={18} />
          </button>
          <button
            type="button"
            className="chat-topbar-btn"
            onClick={() => setShowBookmarks(true)}
            aria-label="Favoritos"
          >
            <Bookmark size={18} />
          </button>
          {activeChannelId && (
            <button
              type="button"
              className="chat-topbar-btn"
              onClick={() => setShowPinned(true)}
              aria-label="Mensajes fijados"
            >
              <Pin size={18} />
            </button>
          )}
          <button
            type="button"
            className="chat-topbar-btn"
            onClick={() => setShowCalendar(true)}
            aria-label="Calendario"
          >
            <Calendar size={18} />
          </button>
        </div>
      </div>

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

      {/* Search dialog */}
      {showSearch && (
        <ChatSearchDialog
          open={showSearch}
          onClose={() => setShowSearch(false)}
          onSelectChannel={(id) => {
            handleSelectChannel(id);
            setShowSearch(false);
          }}
        />
      )}

      {/* Bookmarks panel */}
      {showBookmarks && <ChatBookmarksPanel onClose={() => setShowBookmarks(false)} />}

      {/* Pinned messages panel */}
      {showPinned && activeChannelId && (
        <ChatPinnedPanel channelId={activeChannelId} onClose={() => setShowPinned(false)} />
      )}

      {/* Calendar view */}
      {showCalendar && <ChatCalendarView onClose={() => setShowCalendar(false)} />}
    </div>
  );
}
