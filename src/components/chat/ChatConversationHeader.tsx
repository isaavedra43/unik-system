'use client';

import React from 'react';
import { ArrowLeft, MoreVertical, Users, Phone, Video, Search, Pin } from 'lucide-react';
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
    if (otherUser.status === 'online') return 'En línea';
    if (otherUser.status === 'away') return 'Ausente';
    return 'Desconectado';
  };

  const presence =
    !channel || isGroup || !otherUser
      ? null
      : otherUser.status === 'online'
        ? 'online'
        : otherUser.status === 'away'
          ? 'away'
          : 'offline';

  const canCall = isGroup ? (channel?.members.length ?? 0) <= 8 : true;

  return (
    <div className="chat-conversation-header">
      <button
        type="button"
        className="chat-icon-btn chat-back-btn"
        onClick={onBack}
        aria-label="Volver"
      >
        <ArrowLeft size={20} />
      </button>

      <span
        className={cn('chat-avatar md', isGroup && 'group', !channel && 'is-loading')}
        aria-hidden="true"
      >
        {channel &&
          (isGroup ? <Users size={18} /> : (otherUser?.name.slice(0, 2).toUpperCase() ?? '??'))}
        {otherUserOnline && <span className="chat-presence" />}
      </span>

      <div className="chat-conversation-info">
        <div className="chat-conversation-name">
          {channel ? getChannelName() : <span className="chat-skel-line" aria-hidden="true" />}
        </div>
        <div className="chat-conversation-subtitle" aria-live="polite">
          {typingText ? (
            <span className="chat-typing-inline">
              <span className="chat-typing-bubbles" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className="chat-typing-label">{typingText} está escribiendo</span>
              {typingPreview && <span className="chat-typing-snippet">: {typingPreview}</span>}
            </span>
          ) : (
            <>
              {presence && <span className={cn('chat-status-dot', presence)} aria-hidden="true" />}
              <span className="chat-conversation-status">{getChannelSubtitle()}</span>
            </>
          )}
        </div>
      </div>

      <div className="chat-conversation-actions">
        {canCall && channel && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="chat-icon-btn" aria-label="Llamar" title="Llamar">
                <Phone size={18} />
              </button>
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
          <button
            type="button"
            className="chat-icon-btn"
            onClick={onSearchInChannel}
            aria-label="Buscar en conversación"
            title="Buscar en conversación"
          >
            <Search size={18} />
          </button>
        )}

        {onShowPinned && (
          <button
            type="button"
            className="chat-icon-btn"
            onClick={onShowPinned}
            aria-label="Mensajes fijados"
            title="Mensajes fijados"
          >
            <Pin size={18} />
            {pinnedCount && pinnedCount > 0 ? (
              <span className="chat-icon-badge">{pinnedCount > 99 ? '99+' : pinnedCount}</span>
            ) : null}
          </button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="chat-icon-btn" aria-label="Configuración" title="Más opciones">
              <MoreVertical size={18} />
            </button>
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
            <DropdownMenuItem onClick={onShowSettings}>Configuración</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
