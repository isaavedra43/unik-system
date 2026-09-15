'use client';

import { areaWorkspaceHref, operationsCaseHref } from '@/components/operations/copilot-starters';
import React from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  MoreVertical,
  Users,
  Phone,
  Video,
  Search,
  Pin,
  Sparkles,
  Building2,
  Briefcase,
  FolderOpen,
  LayoutDashboard,
} from 'lucide-react';
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
  aiOpen?: boolean;
  onToggleAi?: () => void;
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
  aiOpen,
  onToggleAi,
}: ChatConversationHeaderProps) {
  const type = channel?.type;
  const isArea = type === 'area';
  const isCase = type === 'case';
  // Area channels and sales rooms: managed by the operations layer (no calls, no settings).
  const isManaged = isArea || isCase;
  // Every non-DM channel renders as a multi-party conversation.
  const isGroup = !!channel && type !== 'dm';
  const otherUser = channel?.members.find((m) => m.userId !== user.id);
  const otherUserOnline = !isGroup && otherUser?.status === 'online';

  const getChannelName = () => {
    if (!channel) return '';
    if (channel.type === 'group') return channel.name ?? 'Grupo';
    if (isArea) return channel.name ?? 'Canal de área';
    if (isCase) return channel.name ?? 'Sala de venta';
    return otherUser?.name ?? 'Usuario';
  };

  const getChannelSubtitle = () => {
    if (!channel) return '';
    if (isArea) return `Canal de área · ${channel.members.length} miembros`;
    if (isCase) return `Sala de venta · ${channel.members.length} miembros`;
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

  const canCall = !isManaged && (isGroup ? (channel?.members.length ?? 0) <= 8 : true);

  // Links to the area work center and the case page appear only once those pages exist.
  const areaHref = isArea ? areaWorkspaceHref(channel?.areaKey) : null;
  const caseHref = isCase ? operationsCaseHref(channel?.caseId) : null;
  const workLink = areaHref
    ? { href: areaHref, label: 'Abrir centro de trabajo', icon: <LayoutDashboard aria-hidden="true" /> }
    : caseHref
      ? { href: caseHref, label: 'Ver expediente', icon: <FolderOpen aria-hidden="true" /> }
      : null;

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
          (isArea ? (
            <Building2 size={18} />
          ) : isCase ? (
            <Briefcase size={18} />
          ) : isGroup ? (
            <Users size={18} />
          ) : (
            (otherUser?.name.slice(0, 2).toUpperCase() ?? '??')
          ))}
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
        {workLink && (
          <Button asChild variant="outline" size="sm">
            <Link href={workLink.href} aria-label={workLink.label} title={workLink.label}>
              {workLink.icon}
              <span className="hidden sm:inline">{workLink.label}</span>
            </Link>
          </Button>
        )}
        {onToggleAi && (
          <button
            type="button"
            className={cn('chat-icon-btn', aiOpen && 'is-active')}
            onClick={onToggleAi}
            aria-pressed={Boolean(aiOpen)}
            aria-label={aiOpen ? 'Ocultar copiloto' : 'Mostrar copiloto'}
            title={aiOpen ? 'Ocultar copiloto' : 'Mostrar copiloto (misma IA del asistente)'}
          >
            <Sparkles size={18} />
          </button>
        )}
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

        {isManaged && channel && (
          <button
            type="button"
            className="chat-icon-btn"
            onClick={onShowSettings}
            aria-label="Ver miembros"
            title="Ver miembros"
          >
            <Users size={18} />
          </button>
        )}

        {!isManaged && (
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
        )}
      </div>
    </div>
  );
}
