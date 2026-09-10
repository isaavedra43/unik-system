'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Menu, Search, Bookmark, Pin, Calendar, BarChart3, Megaphone } from 'lucide-react';
import { Button } from '@/components/shadcn/button';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/shadcn/sheet';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/shadcn/dropdown-menu';
import { MoreVertical } from 'lucide-react';
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
    setSidebarOpen(false);
    if (id) {
      fetch(`/app/chat/api/channels/${id}/read`, { method: 'POST' }).catch(() => {});
    }
  };

  const handleChannelCreated = (id: string) => {
    setActiveChannelId(id);
    setSidebarOpen(false);
    setRefreshKey((k) => k + 1);
  };

  const handleRefresh = () => setRefreshKey((k) => k + 1);
  const handleBack = () => setActiveChannelId(null);

  return (
    <div className="chat-page">
      {/* Compact topbar */}
      <div className="chat-topbar flex items-center gap-1 px-3 py-2 border-b border-border bg-background">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSidebarOpen(true)}
          aria-label="Ver conversaciones"
          className="md:hidden relative"
        >
          <Menu size={18} />
          {totalUnread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[9px] font-bold min-w-[16px] h-4 px-1">
              {totalUnread > 99 ? '99+' : totalUnread}
            </span>
          )}
        </Button>

        <div className="flex-1" />

        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" onClick={() => setShowSearch(true)} aria-label="Buscar mensajes">
            <Search size={18} />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setShowBookmarks(true)} aria-label="Favoritos">
            <Bookmark size={18} />
          </Button>
          {activeChannelId && (
            <Button variant="ghost" size="icon-sm" onClick={() => setShowPinned(true)} aria-label="Mensajes fijados">
              <Pin size={18} />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={() => setShowCalendar(true)} aria-label="Calendario" className="hidden sm:inline-flex">
            <Calendar size={18} />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setShowBroadcast(true)} aria-label="Difundir mensaje" className="hidden sm:inline-flex">
            <Megaphone size={18} />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setShowStats(true)} aria-label="Mis estadísticas" className="hidden sm:inline-flex">
            <BarChart3 size={18} />
          </Button>

          {/* Overflow menu for small screens */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Más opciones" className="sm:hidden">
                <MoreVertical size={18} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setShowCalendar(true)}>
                <Calendar size={16} /> Calendario
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowBroadcast(true)}>
                <Megaphone size={16} /> Difundir
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowStats(true)}>
                <BarChart3 size={16} /> Mis estadísticas
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="chat-page-body">
        {/* Desktop sidebar */}
        <div className="chat-sidebar-wrapper hidden md:flex">
          <ChatSidebar
            activeId={activeChannelId}
            inbox={inbox}
            onSelect={handleSelectChannel}
            onChannelCreated={handleChannelCreated}
          />
        </div>

        {/* Mobile sidebar as Sheet */}
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" className="w-3/4 sm:max-w-xs p-0 gap-0">
            <SheetHeader className="border-b border-border px-4 py-3">
              <SheetTitle>Conversaciones</SheetTitle>
            </SheetHeader>
            <ChatSidebar
              activeId={activeChannelId}
              inbox={inbox}
              onSelect={handleSelectChannel}
              onChannelCreated={handleChannelCreated}
            />
          </SheetContent>
        </Sheet>

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
