'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
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
import { ChatIncomingCallDialog } from './ChatIncomingCallDialog';
import { ChatCallDialog } from './ChatCallDialog';
import type { ChatInboxItem, ChatCallDTO } from '@/modules/chat/chat-events';

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

  // Global incoming call state
  const [incomingCall, setIncomingCall] = useState<ChatCallDTO | null>(null);
  const [activeCalleeCall, setActiveCalleeCall] = useState<ChatCallDTO | null>(null);

  // Refs to track state without causing effect re-runs
  const incomingCallRef = useRef<ChatCallDTO | null>(null);
  const activeCalleeCallRef = useRef<ChatCallDTO | null>(null);
  const knownIncomingCallIds = useRef<Set<string>>(new Set());

  // Keep refs in sync with state
  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  useEffect(() => {
    activeCalleeCallRef.current = activeCalleeCall;
  }, [activeCalleeCall]);

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

  // =====================================================
  // Global incoming call polling
  //
  // Uses refs instead of state dependencies so the interval
  // is set up ONCE on mount and never recreated. This avoids
  // stale closure issues and ensures polling never stops.
  //
  // This works across ALL channels — the callee receives
  // call notifications even if they're not viewing the
  // channel where the call was initiated.
  // =====================================================
  useEffect(() => {
    const pollIncomingCalls = async () => {
      // Don't poll if we're already showing an incoming call or in a call
      if (incomingCallRef.current || activeCalleeCallRef.current) return;
      try {
        const res = await fetch('/app/chat/api/calls/incoming');
        if (!res.ok) return;
        const data = await res.json();
        const calls: ChatCallDTO[] = data.data ?? [];
        if (calls.length > 0) {
          // Show the most recent incoming call that we haven't seen yet
          const newCall = calls.find((c) => !knownIncomingCallIds.current.has(c.id));
          if (newCall) {
            knownIncomingCallIds.current.add(newCall.id);
            setIncomingCall(newCall);
          }
        }
      } catch {
        // silent
      }
    };

    // Poll every 1 second for fast notification
    const interval = setInterval(pollIncomingCalls, 1000);
    // Also poll immediately on mount
    pollIncomingCalls();

    return () => clearInterval(interval);
  }, []); // No dependencies — runs once on mount

  // Presence heartbeat
  useEffect(() => {
    if (typeof window === 'undefined') return;
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

  // =====================================================
  // Incoming call handlers (page level)
  // =====================================================

  // Called by ChatConversation when SSE detects an incoming call
  // in the current channel. This is a fallback to the HTTP polling
  // above — if the SSE detects the call first, we show it immediately.
  const handleSseIncomingCall = useCallback((call: ChatCallDTO) => {
    // Don't show if we already have an incoming call or are in a call
    if (incomingCallRef.current || activeCalleeCallRef.current) return;
    // Don't show if we've already seen this call
    if (knownIncomingCallIds.current.has(call.id)) return;
    // Don't show if we're the caller
    if (call.callerId === user.id) return;
    // Verify we're a participant
    if (!call.participants.some((p) => p.userId === user.id)) return;

    knownIncomingCallIds.current.add(call.id);
    setIncomingCall(call);
  }, [user.id]);

  const handleAcceptIncomingCall = useCallback(() => {
    if (!incomingCall) return;
    const callData = incomingCall;
    setIncomingCall(null);
    // Navigate to the channel where the call is happening
    setActiveChannelId(callData.channelId);
    // Mark as read
    fetch(`/app/chat/api/channels/${callData.channelId}/read`, { method: 'POST' }).catch(() => {});
    // Show the call dialog in callee mode
    setActiveCalleeCall(callData);
  }, [incomingCall]);

  const handleDeclineIncomingCall = useCallback(async () => {
    if (!incomingCall) return;
    try {
      await fetch(`/app/chat/api/calls/${incomingCall.id}/decline`, {
        method: 'POST',
      });
    } catch {
      // silent
    }
    setIncomingCall(null);
  }, [incomingCall]);

  const handleCloseCalleeCall = useCallback(() => {
    setActiveCalleeCall(null);
  }, []);

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
              onIncomingCall={handleSseIncomingCall}
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

      {/* Incoming call notification (page level — works across all channels) */}
      {incomingCall && (
        <ChatIncomingCallDialog
          call={incomingCall}
          onAccept={handleAcceptIncomingCall}
          onDecline={handleDeclineIncomingCall}
        />
      )}

      {/* Active call dialog — callee mode (page level) */}
      {activeCalleeCall && (
        <ChatCallDialog
          channelId={activeCalleeCall.channelId}
          type={activeCalleeCall.type}
          participants={activeCalleeCall.participants.map((p) => ({
            userId: p.userId,
            name: p.name,
          }))}
          currentUserId={user.id}
          onClose={handleCloseCalleeCall}
          role="callee"
          callData={activeCalleeCall}
        />
      )}
    </div>
  );
}
