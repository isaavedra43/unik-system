'use client';

import React from 'react';
import { Inbox, MessageSquarePlus, RefreshCw, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  formatTime,
  initials,
  PROVIDER_LABELS,
  STATUS_LABELS,
  type CommAccountDTO,
  type CommConversationDTO,
  type InboxFilters,
} from './inbox-types';

interface Props {
  accounts: CommAccountDTO[];
  filters: InboxFilters;
  onFiltersChange: (filters: InboxFilters) => void;
  conversations: CommConversationDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  fullWidth?: boolean;
  onNewConversation?: () => void;
}

export function ConversationList({
  accounts,
  filters,
  onFiltersChange,
  conversations,
  selectedId,
  onSelect,
  loading,
  error,
  hasMore,
  onLoadMore,
  onRetry,
  fullWidth,
  onNewConversation,
}: Props) {
  const set = <K extends keyof InboxFilters>(key: K, value: InboxFilters[K]) =>
    onFiltersChange({ ...filters, [key]: value });
  const selectStyle: React.CSSProperties = { flex: 1, minWidth: 0 };

  return (
    <div
      className="chat-sidebar"
      style={fullWidth ? { width: '100%', borderRight: 'none' } : undefined}
    >
      <div className="chat-sidebar-header">
        <div className="chat-sidebar-title-row">
          <div className="chat-sidebar-heading">
            <h2 className="chat-sidebar-title">Bandeja</h2>
            <p className="chat-sidebar-subtitle">
              {accounts.length} canal{accounts.length === 1 ? '' : 'es'}
            </p>
          </div>
          {onNewConversation && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onNewConversation}
              disabled={accounts.length === 0}
              aria-label="Nueva conversación"
              title="Nueva conversación"
            >
              <MessageSquarePlus size={16} /> Nueva
            </button>
          )}
        </div>
        <div className="chat-sidebar-search" style={{ position: 'relative' }}>
          <Search
            size={16}
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              opacity: 0.6,
            }}
          />
          <input
            type="search"
            className="input"
            aria-label="Buscar en contactos y mensajes"
            placeholder="Buscar contacto o mensaje…"
            value={filters.search}
            onChange={(e) => set('search', e.target.value)}
            style={{ width: '100%', paddingLeft: 32 }}
          />
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <select
            className="select"
            aria-label="Canal"
            value={filters.accountId}
            onChange={(e) => set('accountId', e.target.value)}
            style={selectStyle}
          >
            <option value="">Todos los canales</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {PROVIDER_LABELS[a.provider] ?? a.provider} · {a.label}
              </option>
            ))}
          </select>
          <select
            className="select"
            aria-label="Estado"
            value={filters.status}
            onChange={(e) => set('status', e.target.value as InboxFilters['status'])}
            style={selectStyle}
          >
            <option value="open">Abiertas</option>
            <option value="pending">Pendientes</option>
            <option value="snoozed">Pospuestas</option>
            <option value="resolved">Resueltas</option>
            <option value="all">Todas</option>
          </select>
          <select
            className="select"
            aria-label="Asignación"
            value={filters.assigned}
            onChange={(e) => set('assigned', e.target.value as InboxFilters['assigned'])}
            style={selectStyle}
          >
            <option value="all">Del equipo</option>
            <option value="me">Asignadas a mí</option>
            <option value="unassigned">Sin asignar</option>
          </select>
        </div>
      </div>
      <div className="chat-sidebar-content" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {loading && conversations.length === 0 && (
          <div className="chat-panel-loading" style={{ padding: 16 }}>
            Cargando conversaciones…
          </div>
        )}
        {error && (
          <div className="assistant-admin-error" role="alert" style={{ margin: 12 }}>
            {error}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onRetry}
              style={{ marginLeft: 8 }}
            >
              <RefreshCw size={14} /> Reintentar
            </button>
          </div>
        )}
        {!loading && !error && conversations.length === 0 && (
          <div className="chat-sidebar-empty" style={{ padding: 24, textAlign: 'center' }}>
            <Inbox size={28} aria-hidden="true" className="chat-sidebar-empty-icon" />
            <p>No hay conversaciones con estos filtros.</p>
          </div>
        )}
        <div className="chat-sidebar-list" role="list">
          {conversations.map((c) => {
            const active = c.id === selectedId;
            const unread = c.unreadCount > 0;
            return (
              <button
                key={c.id}
                type="button"
                role="listitem"
                className={cn('chat-sidebar-item', active && 'active', unread && 'unread')}
                onClick={() => onSelect(c.id)}
                aria-current={active ? 'true' : undefined}
              >
                <span className="chat-avatar" aria-hidden="true">
                  {initials(c.contact.displayName)}
                </span>
                <span className="chat-sidebar-content">
                  <span className="chat-sidebar-row">
                    <span className="chat-sidebar-name">{c.contact.displayName}</span>
                    <span className="chat-sidebar-time">{formatTime(c.lastMessageAt)}</span>
                  </span>
                  <span className="chat-sidebar-row">
                    <span className="chat-sidebar-preview">
                      {c.lastMessage
                        ? `${c.lastMessage.direction === 'outbound' ? 'Tú: ' : ''}${c.lastMessage.preview || '[adjunto]'}`
                        : 'Sin mensajes'}
                    </span>
                    {unread && (
                      <span className="chat-sidebar-badge" aria-label={`${c.unreadCount} sin leer`}>
                        {c.unreadCount > 99 ? '99+' : c.unreadCount}
                      </span>
                    )}
                  </span>
                  <span className="chat-sidebar-row" style={{ gap: 6, marginTop: 2 }}>
                    <span className="badge badge-weak">
                      {PROVIDER_LABELS[c.account.provider] ?? c.account.provider}
                    </span>
                    {c.status !== 'open' && (
                      <span className="badge badge-info">
                        {STATUS_LABELS[c.status] ?? c.status}
                      </span>
                    )}
                    {c.priority !== 'normal' && (
                      <span className="badge badge-warning">
                        {c.priority === 'urgent' ? 'Urgente' : 'Alta'}
                      </span>
                    )}
                    {c.assignedToName && (
                      <span className="chat-sidebar-subtitle" style={{ marginLeft: 'auto' }}>
                        {c.assignedToName}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {hasMore && (
          <div style={{ padding: 12, textAlign: 'center' }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onLoadMore}>
              Cargar más
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
