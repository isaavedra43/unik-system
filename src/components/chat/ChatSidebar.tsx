'use client';

import React, { useState, useMemo } from 'react';
import {
  Plus,
  Search,
  Users,
  MessageCircle,
  ChevronRight,
  Bookmark,
  Calendar,
  BarChart3,
  Megaphone,
} from 'lucide-react';
import { ChatNewDialog } from './ChatNewDialog';
import { Button, Input } from '@/components/ui/primitives';
import { ScrollArea } from '@/components/shadcn/scroll-area';
import { cn } from '@/lib/utils';
import type { ChatInboxItem } from '@/modules/chat/chat-events';

export interface ChatSidebarGlobalActions {
  onSearchMessages?: () => void;
  onShowBookmarks?: () => void;
  onShowCalendar?: () => void;
  onShowBroadcast?: () => void;
  onShowStats?: () => void;
}

export interface ChatSidebarProps {
  activeId: string | null;
  inbox: ChatInboxItem[];
  onSelect: (id: string | null) => void;
  onChannelCreated: (id: string) => void;
  globalActions?: ChatSidebarGlobalActions;
}

function formatTime(iso: string): string {
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
}

function getDisplayName(item: ChatInboxItem): string {
  if (item.type === 'group') return item.name ?? 'Grupo';
  return item.otherUserName ?? 'Usuario';
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function ChatSidebarItem({
  item,
  isActive,
  onSelect,
}: {
  item: ChatInboxItem;
  isActive: boolean;
  onSelect: (id: string) => void;
}) {
  const name = getDisplayName(item);
  const isGroup = item.type === 'group';
  const hasUnread = item.unreadCount > 0;
  return (
    <button
      type="button"
      className={cn('chat-sidebar-item', isActive && 'active', hasUnread && 'unread')}
      onClick={() => onSelect(item.channelId)}
      aria-current={isActive ? 'true' : undefined}
    >
      <span className={cn('chat-avatar', isGroup && 'group')} aria-hidden="true">
        {isGroup ? <Users size={18} /> : getInitials(name)}
        {item.type === 'dm' && item.otherUserStatus === 'online' && (
          <span className="chat-presence" />
        )}
      </span>
      <span className="chat-sidebar-content">
        <span className="chat-sidebar-row">
          <span className="chat-sidebar-name">{name}</span>
          <span className="chat-sidebar-time">{formatTime(item.lastMessageAt)}</span>
        </span>
        <span className="chat-sidebar-row">
          <span className="chat-sidebar-preview">{item.lastMessagePreview ?? 'Sin mensajes'}</span>
          {hasUnread && (
            <span className="chat-sidebar-badge" aria-label={`${item.unreadCount} sin leer`}>
              {item.unreadCount > 99 ? '99+' : item.unreadCount}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function Section({
  title,
  items,
  activeId,
  onSelect,
  defaultOpen = true,
}: {
  title: string;
  items: ChatInboxItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;
  return (
    <div className="chat-sidebar-section">
      <button
        type="button"
        className="chat-sidebar-section-title"
        onClick={() => setOpen((p) => !p)}
        aria-expanded={open}
      >
        <ChevronRight size={14} className={cn('chat-sidebar-chevron', open && 'open')} />
        <span>{title}</span>
        <span className="chat-sidebar-section-count">{items.length}</span>
      </button>
      {open && (
        <div className="chat-sidebar-section-items">
          {items.map((item) => (
            <ChatSidebarItem
              key={item.channelId}
              item={item}
              isActive={item.channelId === activeId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ChatSidebar({ activeId, inbox, onSelect, onChannelCreated, globalActions }: ChatSidebarProps) {
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);

  const filtered = useMemo(() => {
    if (!search.trim()) return inbox;
    const q = search.toLowerCase();
    return inbox.filter((item) => {
      const name = getDisplayName(item).toLowerCase();
      return name.includes(q);
    });
  }, [inbox, search]);

  const sections = useMemo(() => {
    const recent = [...filtered]
      .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
      .slice(0, 10);
    const dms = filtered
      .filter((i) => i.type === 'dm')
      .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
    const groups = filtered
      .filter((i) => i.type === 'group')
      .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
    return { recent, dms, groups };
  }, [filtered]);

  const totalUnread = useMemo(() => inbox.reduce((sum, i) => sum + i.unreadCount, 0), [inbox]);

  const quickActions = globalActions
    ? [
        { key: 'search', label: 'Buscar', title: 'Buscar mensajes', icon: Search, onClick: globalActions.onSearchMessages },
        { key: 'bookmarks', label: 'Favoritos', title: 'Favoritos', icon: Bookmark, onClick: globalActions.onShowBookmarks },
        { key: 'calendar', label: 'Agenda', title: 'Calendario', icon: Calendar, onClick: globalActions.onShowCalendar },
        { key: 'broadcast', label: 'Difundir', title: 'Difundir mensaje', icon: Megaphone, onClick: globalActions.onShowBroadcast },
        { key: 'stats', label: 'Métricas', title: 'Mis estadísticas', icon: BarChart3, onClick: globalActions.onShowStats },
      ]
    : [];

  return (
    <div className="chat-sidebar">
      <div className="chat-sidebar-header">
        <div className="chat-sidebar-title-row">
          <div className="chat-sidebar-heading">
            <h2 className="chat-sidebar-title">Mensajes</h2>
            <p className="chat-sidebar-subtitle">
              {totalUnread > 0 ? (
                <>
                  <span className="chat-sidebar-unread-dot" aria-hidden="true" />
                  {totalUnread > 99 ? '99+' : totalUnread} sin leer
                </>
              ) : (
                'Todo al día'
              )}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="chat-sidebar-new-btn"
            onClick={() => setShowNew(true)}
            icon={<Plus size={16} />}
          >
            Nuevo chat
          </Button>
        </div>

        <div className="chat-sidebar-searchbox">
          <Input
            type="text"
            placeholder="Buscar conversación..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar conversación"
            leftIcon={<Search size={16} />}
          />
        </div>

        {quickActions.length > 0 && (
          <div className="chat-quick-actions" role="toolbar" aria-label="Herramientas del chat">
            {quickActions.map(({ key, label, title, icon: Icon, onClick }) => (
              <button
                key={key}
                type="button"
                className="chat-quick-action"
                onClick={onClick}
                aria-label={title}
                title={title}
              >
                <Icon size={17} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="chat-sidebar-list-inner">
          {filtered.length === 0 && (
            <div className="chat-sidebar-empty">
              <span className="chat-sidebar-empty-icon" aria-hidden="true">
                {search.trim() ? <Search size={18} /> : <MessageCircle size={18} />}
              </span>
              {search.trim() ? 'No se encontraron conversaciones' : 'No hay conversaciones aún'}
            </div>
          )}
          {filtered.length > 0 && (
            <>
              {!search.trim() && (
                <Section
                  title="Recientes"
                  items={sections.recent}
                  activeId={activeId}
                  onSelect={onSelect}
                />
              )}
              <Section
                title="Mensajes directos"
                items={search.trim() ? sections.dms : sections.dms.filter((i) => !sections.recent.includes(i))}
                activeId={activeId}
                onSelect={onSelect}
                defaultOpen={!!search.trim()}
              />
              <Section
                title="Grupos"
                items={search.trim() ? sections.groups : sections.groups.filter((i) => !sections.recent.includes(i))}
                activeId={activeId}
                onSelect={onSelect}
                defaultOpen={!!search.trim()}
              />
            </>
          )}
        </div>
      </ScrollArea>

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
