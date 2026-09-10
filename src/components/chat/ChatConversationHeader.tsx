'use client';

import React from 'react';
import { ArrowLeft, MoreVertical, Users, Phone, Video, Search, Pin } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/shadcn/avatar';
import { Button } from '@/components/shadcn/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/shadcn/dropdown-menu';
import { cn } from '@/lib/utils';
import type { ChatChannelDTO } from '@/modules/chat/chat-events';
import type { CurrentUser } from '@/modules/auth/authorization';

export interface ChatConversationHeaderProps {
  channel: ChatChannelDTO | null;
  user: CurrentUser;
  typingText: string;
  typingPreview?: string;
  onBack: () => void;
  onShowSettings: () => void;
  onCallAudio: () => void;
  onCallVideo: () => void;
  onSearchInChannel?: () => void;
  pinnedCount?: number;
  onShowPinned?: () => void;
}

export function ChatConversationHeader({
  channel,
  user,
  typingText,
  typingPreview,
  onBack,
  onShowSettings,
  onCallAudio,
  onCallVideo,
  onSearchInChannel,
  pinnedCount,
  onShowPinned,
}: ChatConversationHeaderProps) {
  const isGroup = channel?.type === 'group';
  const otherUser = channel?.members.find((m) => m.userId !== user.id);
  const otherUserOnline = !isGroup && otherUser?.status === 'online';

  const getChannelName = () => {
    if (!channel) return '';
    if (channel.type === 'group') return channel.name ?? 'Grupo';
    return otherUser?.name ?? 'Usuario';
  };

  const getChannelSubtitle = () => {
    if (!channel) return '';
    if (isGroup) return `${channel.members.length} miembros`;
    if (!otherUser) return '';
    if (otherUser.status === 'online') return 'en línea';
    if (otherUser.status === 'away') return 'ausente';
    return 'desconectado';
  };

  const canCall = isGroup ? (channel?.members.length ?? 0) <= 8 : true;

  return (
    <div className="chat-conversation-header flex items-center gap-2 px-3 py-2 border-b border-border bg-background min-h-[56px]">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onBack}
        aria-label="Volver"
        className="md:hidden shrink-0"
      >
        <ArrowLeft size={18} />
      </Button>

      <div className="relative shrink-0">
        <Avatar className="size-9">
          <AvatarFallback
            className={cn('text-xs font-semibold', isGroup && 'bg-primary text-primary-foreground')}
          >
            {isGroup ? (
              <Users size={18} />
            ) : (
              otherUser?.name.slice(0, 2).toUpperCase() ?? '??'
            )}
          </AvatarFallback>
        </Avatar>
        {otherUserOnline && (
          <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-success ring-2 ring-background" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-foreground truncate">{getChannelName()}</div>
        <div className="text-xs text-muted-foreground truncate">
          {typingText ? (
            <span className="flex items-center gap-1.5">
              <span className="flex gap-0.5">
                <span className="size-1 rounded-full bg-primary animate-pulse" style={{ animationDelay: '0ms' }} />
                <span className="size-1 rounded-full bg-primary animate-pulse" style={{ animationDelay: '150ms' }} />
                <span className="size-1 rounded-full bg-primary animate-pulse" style={{ animationDelay: '300ms' }} />
              </span>
              <span className="text-primary font-medium">{typingText} está escribiendo</span>
              {typingPreview && <span className="italic">: {typingPreview}</span>}
            </span>
          ) : (
            getChannelSubtitle()
          )}
        </div>
      </div>

      {canCall && channel && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Llamar">
              <Phone size={18} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onCallAudio}>
              <Phone size={16} /> Llamada de voz
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onCallVideo}>
              <Video size={16} /> Videollamada
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {onSearchInChannel && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onSearchInChannel}
          aria-label="Buscar en conversación"
          className="shrink-0"
        >
          <Search size={18} />
        </Button>
      )}

      {onShowPinned && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onShowPinned}
          aria-label="Mensajes fijados"
          className="relative shrink-0"
        >
          <Pin size={18} />
          {pinnedCount && pinnedCount > 0 ? (
            <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[9px] font-bold min-w-[16px] h-4 px-1">
              {pinnedCount > 99 ? '99+' : pinnedCount}
            </span>
          ) : null}
        </Button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Configuración" className="shrink-0">
            <MoreVertical size={18} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onShowSettings}>
            <Users size={16} /> Ver información
          </DropdownMenuItem>
          {onShowPinned && (
            <DropdownMenuItem onClick={onShowPinned}>
              <Pin size={16} /> Mensajes fijados
              {pinnedCount && pinnedCount > 0 ? ` (${pinnedCount})` : ''}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onShowSettings} className="text-destructive">
            Configuración
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
