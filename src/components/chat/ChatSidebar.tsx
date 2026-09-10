'use client';

import React, { useState, useMemo } from 'react';
import { Plus, Search, Users, MessageCircle, ChevronDown, ChevronRight, Pin } from 'lucide-react';
import { ChatNewDialog } from './ChatNewDialog';
import { Input } from '@/components/shadcn/input';
import { Button } from '@/components/shadcn/button';
import { Avatar, AvatarFallback } from '@/components/shadcn/avatar';
import { ScrollArea } from '@/components/shadcn/scroll-area';
import { cn } from '@/lib/utils';
import type { ChatInboxItem } from '@/modules/chat/chat-events';

export interface ChatSidebarProps {
  activeId: string | null;
  inbox: ChatInboxItem[];
  onSelect: (id: string | null) => void;
  onChannelCreated: (id: string) => void;
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
  return (
    <button
      type="button"
      className={cn(
        'flex items-center gap-3 w-full rounded-md p-2 text-left transition-colors',
        'hover:bg-accent focus:bg-accent focus:outline-none',
        isActive && 'bg-primary/10 ring-1 ring-primary/30'
      )}
      onClick={() => onSelect(item.channelId)}
    >
      <div className="relative shrink-0">
        <Avatar className="size-9">
          <AvatarFallback
            className={cn('text-xs font-semibold', item.type === 'group' && 'bg-primary text-primary-foreground')}
          >
            {item.type === 'group' ? <Users size={16} /> : getInitials(name)}
          </AvatarFallback>
        </Avatar>
        {item.type === 'dm' && item.otherUserStatus === 'online' && (
          <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-success ring-2 ring-background" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground truncate">{name}</span>
          <span className="text-[11px] text-muted-foreground shrink-0">
            {formatTime(item.lastMessageAt)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground truncate flex-1">
            {item.lastMessagePreview ?? 'Sin mensajes'}
          </span>
          {item.unreadCount > 0 && (
            <span
              className={cn(
                'inline-flex items-center justify-center rounded-full px-1.5 min-w-[20px] h-5',
                'text-[10px] font-bold shrink-0',
                'bg-primary text-primary-foreground'
              )}
            >
              {item.unreadCount > 99 ? '99+' : item.unreadCount}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function Section({
  title,
  icon: Icon,
  items,
  activeId,
  onSelect,
  defaultOpen = true,
}: {
  title: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  items: ChatInboxItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setOpen((p) => !p)}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Icon size={14} />
        {title}
        <span className="ml-auto text-[10px] font-normal">{items.length}</span>
      </button>
      {open &&
        items.map((item) => (
          <ChatSidebarItem
            key={item.channelId}
            item={item}
            isActive={item.channelId === activeId}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

export function ChatSidebar({ activeId, inbox, onSelect, onChannelCreated }: ChatSidebarProps) {
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

  return (
    <div className="chat-sidebar">
      <div className="chat-sidebar-header flex flex-col gap-2 p-3 border-b border-border">
        <Button onClick={() => setShowNew(true)} className="w-full" size="sm">
          <Plus size={16} /> Nuevo chat
        </Button>
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <Input
            type="text"
            placeholder="Buscar conversación..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            aria-label="Buscar conversación"
          />
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-2">
          {filtered.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {search.trim() ? 'No se encontraron conversaciones' : 'No hay conversaciones aún'}
            </div>
          )}
          {filtered.length > 0 && (
            <>
              {!search.trim() && (
                <Section
                  title="Recientes"
                  icon={MessageCircle}
                  items={sections.recent}
                  activeId={activeId}
                  onSelect={onSelect}
                />
              )}
              <Section
                title="Mensajes directos"
                icon={MessageCircle}
                items={search.trim() ? sections.dms : sections.dms.filter((i) => !sections.recent.includes(i))}
                activeId={activeId}
                onSelect={onSelect}
                defaultOpen={!!search.trim()}
              />
              <Section
                title="Grupos"
                icon={Users}
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
