'use client';

import React, { useState, useEffect } from 'react';
import { X, Users, UserPlus, UserMinus, Trash2, Search } from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { ChatChannelDTO } from '@/modules/chat/chat-events';

export interface ChatGroupSettingsProps {
  channel: ChatChannelDTO;
  user: CurrentUser;
  onClose: () => void;
  onRefresh: () => void;
}

export function ChatGroupSettings({ channel, user, onClose, onRefresh }: ChatGroupSettingsProps) {
  const [name, setName] = useState(channel.name ?? '');
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<
    { id: string; name: string; username: string }[]
  >([]);
  const [error, setError] = useState<string | null>(null);

  const isGroup = channel.type === 'group';
  const isOwner = channel.members.find((m) => m.userId === user.id)?.role === 'owner';
  const isAdmin = isOwner || channel.members.find((m) => m.userId === user.id)?.role === 'admin';

  useEffect(() => {
    setName(channel.name ?? '');
  }, [channel]);

  useEffect(() => {
    if (search.trim().length < 1) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/app/chat/api/users/search?q=${encodeURIComponent(search)}`);
        if (res.ok) {
          const json = await res.json();
          // Filter out existing members
          const memberIds = new Set(channel.members.map((m) => m.userId));
          setSearchResults(json.data.filter((u: { id: string }) => !memberIds.has(u.id)));
        }
      } catch {
        // silent
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [search, channel.members]);

  const handleSaveName = async () => {
    if (name.trim() === channel.name) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/app/chat/api/channels/${channel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Error');
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setSaving(false);
    }
  };

  const handleAddMember = async (userId: string) => {
    setError(null);
    try {
      const res = await fetch(`/app/chat/api/channels/${channel.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [userId] }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Error');
      }
      setSearch('');
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    setError(null);
    try {
      const res = await fetch(`/app/chat/api/channels/${channel.id}/members?userId=${userId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Error');
      }
      if (userId === user.id) {
        onClose();
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  };

  const handleDeleteGroup = async () => {
    if (!confirm('¿Estás seguro de eliminar este grupo? Esta acción no se puede deshacer.')) return;
    setError(null);
    try {
      const res = await fetch(`/app/chat/api/channels/${channel.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Error');
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  };

  const getStatusLabel = (status: string) => {
    if (status === 'online') return 'en línea';
    if (status === 'away') return 'ausente';
    return 'desconectado';
  };

  return (
    <div className="chat-settings-overlay" onClick={onClose}>
      <div className="chat-settings-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="chat-settings-header">
          <h2>Información</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>

        <div className="chat-settings-body">
          {/* Channel avatar */}
          <div className="chat-settings-avatar">
            {isGroup ? (
              <Users size={36} />
            ) : (
              <span>
                {channel.members
                  .find((m) => m.userId !== user.id)
                  ?.name.slice(0, 2)
                  .toUpperCase()}
              </span>
            )}
          </div>

          {/* Name */}
          {isGroup && isAdmin ? (
            <div className="chat-settings-name-edit">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                placeholder="Nombre del grupo"
              />
              <button
                type="button"
                onClick={handleSaveName}
                disabled={saving || name.trim() === channel.name}
              >
                {saving ? '...' : 'Guardar'}
              </button>
            </div>
          ) : (
            <div className="chat-settings-name">
              {isGroup ? channel.name : channel.members.find((m) => m.userId !== user.id)?.name}
            </div>
          )}

          {/* Members count */}
          <div className="chat-settings-members-count">
            {channel.members.length} {channel.members.length === 1 ? 'miembro' : 'miembros'}
          </div>

          {/* Add members (group only, admin only) */}
          {isGroup && isAdmin && (
            <div className="chat-settings-add">
              <div className="chat-settings-search">
                <Search size={16} />
                <input
                  type="text"
                  placeholder="Agregar miembros..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {searchResults.length > 0 && (
                <div className="chat-settings-search-results">
                  {searchResults.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      className="chat-settings-search-item"
                      onClick={() => handleAddMember(u.id)}
                    >
                      <div className="chat-dialog-user-avatar">
                        {u.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="chat-dialog-user-info">
                        <div className="chat-dialog-user-name">{u.name}</div>
                        <div className="chat-dialog-user-username">@{u.username}</div>
                      </div>
                      <UserPlus size={18} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Members list */}
          <div className="chat-settings-members">
            {channel.members.map((m) => (
              <div key={m.userId} className="chat-settings-member">
                <div className="chat-settings-member-avatar">
                  {m.name.slice(0, 2).toUpperCase()}
                  {m.status === 'online' && <span className="chat-sidebar-presence online" />}
                </div>
                <div className="chat-settings-member-info">
                  <div className="chat-settings-member-name">
                    {m.name}
                    {m.userId === user.id && <span className="chat-settings-you"> (tú)</span>}
                  </div>
                  <div className="chat-settings-member-status">{getStatusLabel(m.status)}</div>
                </div>
                {m.role === 'owner' && <span className="chat-settings-role">admin</span>}
                {isGroup && isAdmin && m.userId !== user.id && (
                  <button
                    type="button"
                    className="chat-settings-remove"
                    onClick={() => handleRemoveMember(m.userId)}
                    aria-label={`Remover ${m.name}`}
                  >
                    <UserMinus size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className="chat-settings-actions">
            <button
              type="button"
              className="chat-settings-leave"
              onClick={() => handleRemoveMember(user.id)}
            >
              {isGroup ? 'Salir del grupo' : 'Cerrar conversación'}
            </button>
            {isGroup && isOwner && (
              <button type="button" className="chat-settings-delete" onClick={handleDeleteGroup}>
                <Trash2 size={16} /> Eliminar grupo
              </button>
            )}
          </div>

          {error && <div className="chat-settings-error">{error}</div>}
        </div>
      </div>
    </div>
  );
}
