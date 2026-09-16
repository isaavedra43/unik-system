'use client';

// `.area-comms-list` vive en `area-shell.css`, que sólo importaban los layouts de
// área: la story se dibujaba sin estilo. Se carga desde el componente para que se
// vea igual en la app y en Storybook.
import '@/styles/operations/area-shell.css';
import '@/styles/operations/area-comms.css';
import Link from 'next/link';
import { Briefcase, Building2, Inbox, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  channelActivityLabel,
  type AreaCommsChannel,
  type AreaCommsChannels,
  type AreaCommsTab,
} from './area-comms-model';

/**
 * Left rail of the communications space (plan 7.5): the channel of the area,
 * the sales rooms the person belongs to (unread first) and the way into the
 * requests and the external inbox.
 *
 * Presentational on purpose — it only receives data and callbacks — so it is
 * the piece with a story and the one every layout (desktop, mobile) reuses.
 * It leans on the internal chat classes so a conversation looks the same here
 * as it does in the chat.
 */

export interface AreaCommsListProps {
  areaLabel: string;
  channels: AreaCommsChannels;
  /** Open conversation, when the chat tab is the active one. */
  selectedId: string | null;
  onSelect: (channelId: string) => void;
  activeTab: AreaCommsTab;
  requests: { incoming: number; incomingOverdue: number; outgoing: number };
  requestsHref: string;
  chatHref: string;
  /** null when the person may not use the external inbox. */
  externalHref: string | null;
  externalAccounts: number;
  /** Why there is no area channel, in Spanish. */
  note: string | null;
  /** Clock of the render, so "hace 3 min" matches the server. */
  nowIso: string;
  fullWidth?: boolean;
}

function ChannelItem({
  channel,
  icon,
  active,
  onSelect,
  nowIso,
}: {
  channel: AreaCommsChannel;
  icon: React.ReactNode;
  active: boolean;
  onSelect: (channelId: string) => void;
  nowIso: string;
}) {
  const unread = channel.unreadCount > 0;
  return (
    <button
      type="button"
      className={cn('chat-sidebar-item', active && 'active', unread && 'unread')}
      onClick={() => onSelect(channel.id)}
      aria-current={active ? 'true' : undefined}
    >
      <span className="chat-avatar group" aria-hidden="true">
        {icon}
      </span>
      <span className="chat-sidebar-content">
        <span className="chat-sidebar-row">
          <span className="chat-sidebar-name">{channel.name}</span>
          <span className="chat-sidebar-time">{channelActivityLabel(channel, nowIso)}</span>
        </span>
        <span className="chat-sidebar-row">
          <span className="chat-sidebar-preview">
            {channel.lastMessagePreview ?? 'Sin mensajes'}
          </span>
          {unread ? (
            <span className="chat-sidebar-badge" aria-label={`${channel.unreadCount} sin leer`}>
              {channel.unreadCount > 99 ? '99+' : channel.unreadCount}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

export function AreaCommsList({
  areaLabel,
  channels,
  selectedId,
  onSelect,
  activeTab,
  requests,
  requestsHref,
  chatHref,
  externalHref,
  externalAccounts,
  note,
  nowIso,
  fullWidth,
}: AreaCommsListProps) {
  const { areaChannel, caseRooms, totalUnread } = channels;

  return (
    <div
      className="chat-sidebar"
      style={fullWidth ? { width: '100%', borderRight: 'none' } : { width: '100%' }}
    >
      <div className="chat-sidebar-header">
        <div className="chat-sidebar-title-row">
          <div className="chat-sidebar-heading">
            <h2 className="chat-sidebar-title">Conversaciones</h2>
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
        </div>
      </div>

      <div className="chat-sidebar-content" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div className="chat-sidebar-section">
          <p className="chat-sidebar-section-title" aria-hidden="true">
            <span>Canal del área</span>
          </p>
          <div className="chat-sidebar-section-items">
            {areaChannel ? (
              <ChannelItem
                channel={areaChannel}
                icon={<Building2 size={18} />}
                active={activeTab === 'chat' && areaChannel.id === selectedId}
                onSelect={onSelect}
                nowIso={nowIso}
              />
            ) : (
              <p className="area-comms-note">
                {note ?? `Todavía no eres parte del canal de ${areaLabel}.`}
              </p>
            )}
          </div>
        </div>

        <div className="chat-sidebar-section">
          <p className="chat-sidebar-section-title" aria-hidden="true">
            <span>Expedientes</span>
            <span className="chat-sidebar-section-count">{caseRooms.length}</span>
          </p>
          <div className="chat-sidebar-section-items">
            {caseRooms.length === 0 ? (
              <p className="area-comms-note">
                Aquí aparecen las salas de las ventas en las que participas.
              </p>
            ) : (
              caseRooms.map((room) => (
                <ChannelItem
                  key={room.id}
                  channel={room}
                  icon={<Briefcase size={18} />}
                  active={activeTab === 'chat' && room.id === selectedId}
                  onSelect={onSelect}
                  nowIso={nowIso}
                />
              ))
            )}
          </div>
        </div>
      </div>

      <nav className="area-comms-nav" aria-label="Otras comunicaciones del área">
        <Link
          href={chatHref}
          className="area-comms-nav-item"
          aria-current={activeTab === 'chat' ? 'page' : undefined}
        >
          <Building2 size={16} aria-hidden="true" />
          <span>Canal y expedientes</span>
        </Link>
        <Link
          href={requestsHref}
          className="area-comms-nav-item"
          aria-current={activeTab === 'solicitudes' ? 'page' : undefined}
        >
          <Send size={16} aria-hidden="true" />
          <span>Solicitudes</span>
          <span className="area-comms-nav-count">
            {requests.incomingOverdue > 0
              ? `${requests.incoming} · ${requests.incomingOverdue} vencidas`
              : `${requests.incoming} recibidas · ${requests.outgoing} enviadas`}
          </span>
        </Link>
        {externalHref ? (
          <Link
            href={externalHref}
            className="area-comms-nav-item"
            aria-current={activeTab === 'externos' ? 'page' : undefined}
          >
            <Inbox size={16} aria-hidden="true" />
            <span>Clientes y proveedores</span>
            <span className="area-comms-nav-count">
              {externalAccounts === 1 ? '1 canal' : `${externalAccounts} canales`}
            </span>
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
