'use client';

import React, { useState, useEffect, useCallback } from 'react';
import type { CurrentUser } from '@/modules/auth/authorization';
import { ChatSidebar } from './ChatSidebar';
import { ChatConversation } from './ChatConversation';
import { ChatEmptyState } from './ChatEmptyState';
import { ChatSearchDialog } from './ChatSearchDialog';
import { ChatBookmarksPanel } from './ChatBookmarksPanel';
import { ChatPinnedPanel } from './ChatPinnedPanel';
import { ChatCalendarView } from './ChatCalendarView';
import { ChatPersonalStats } from './ChatPersonalStats';
import { ChatBroadcastDialog } from './ChatBroadcastDialog';
import type { ChatInboxItem } from '@/modules/chat/chat-events';

export interface ChatPageClientProps {
  user: CurrentUser;
}

export function ChatPageClient({ user }: ChatPageClientProps) {
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [inbox, setInbox] = useState<ChatInboxItem[]>([]);
  const [totalUnread, setTotalUnread] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showPinned, setShowPinned] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);

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
    if (id) {
      fetch(`/app/chat/api/channels/${id}/read`, { method: 'POST' }).catch(() => {});
    }
  };

  const handleChannelCreated = (id: string) => {
    setActiveChannelId(id);
    setRefreshKey((k) => k + 1);
  };

  const handleRefresh = () => setRefreshKey((k) => k + 1);
  const handleBack = () => setActiveChannelId(null);

  const globalActions = {
    onSearchMessages: () => setShowSearch(true),
    onShowBookmarks: () => setShowBookmarks(true),
    onShowCalendar: () => setShowCalendar(true),
    onShowBroadcast: () => setShowBroadcast(true),
    onShowStats: () => setShowStats(true),
  };

  return (
    <div className="chat-page">
      <div className="chat-page-body">
        {/* Sidebar — always visible on desktop; on mobile, visible when no conversation active */}
        <div className={`chat-sidebar-wrapper ${activeChannelId ? 'chat-mobile-hidden' : 'chat-mobile-show'}`}>
          <ChatSidebar
            activeId={activeChannelId}
            inbox={inbox}
            onSelect={handleSelectChannel}
            onChannelCreated={handleChannelCreated}
            globalActions={globalActions}
          />
        </div>

        {/* Main conversation area — always visible on desktop; on mobile, visible when conversation active */}
        <div className={`chat-page-main ${activeChannelId ? 'chat-mobile-show' : 'chat-mobile-hidden'}`}>
          {activeChannelId ? (
            <ChatConversation
              channelId={activeChannelId}
              user={user}
              onRefresh={handleRefresh}
              onBack={handleBack}
            />
          ) : (
            <ChatEmptyState />
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

      {/* Personal stats */}
      {showStats && <ChatPersonalStats onClose={() => setShowStats(false)} />}

      {/* Broadcast dialog */}
      {showBroadcast && (
        <ChatBroadcastDialog
          onClose={() => setShowBroadcast(false)}
          onSent={() => handleRefresh()}
        />
      )}
    </div>
  );
}
