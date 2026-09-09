'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { X, Search, Users, Check } from 'lucide-react';

export interface ChatNewDialogProps {
  onClose: () => void;
  onChannelCreated: (id: string) => void;
}

interface UserSearchResult {
  id: string;
  name: string;
  username: string;
  email: string | null;
  status: string;
}

export function ChatNewDialog({ onClose, onChannelCreated }: ChatNewDialogProps) {
  const [mode, setMode] = useState<'dm' | 'group'>('dm');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [selected, setSelected] = useState<UserSearchResult[]>([]);
  const [groupName, setGroupName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (search.trim().length < 1) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/app/chat/api/users/search?q=${encodeURIComponent(search)}`);
        if (res.ok) {
          const json = await res.json();
          setResults(json.data);
        }
      } catch {
        // silent
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);

  const toggleSelect = (user: UserSearchResult) => {
    if (mode === 'dm') {
      setSelected([user]);
    } else {
      setSelected((prev) => {
        const exists = prev.find((u) => u.id === user.id);
        if (exists) return prev.filter((u) => u.id !== user.id);
        return [...prev, user];
      });
    }
  };

  const handleCreate = useCallback(async () => {
    if (selected.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      if (mode === 'dm') {
        const res = await fetch('/app/chat/api/channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'dm', otherUserId: selected[0].id }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Error al crear el chat');
        }
        const data = await res.json();
        onChannelCreated(data.id);
      } else {
        if (!groupName.trim()) {
          setError('Ingresa un nombre para el grupo');
          setLoading(false);
          return;
        }
        const res = await fetch('/app/chat/api/channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'group',
            name: groupName,
            memberIds: selected.map((u) => u.id),
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Error al crear el grupo');
        }
        const data = await res.json();
        onChannelCreated(data.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, [mode, selected, groupName, onChannelCreated]);

  return (
    <div className="chat-dialog-overlay" onClick={onClose}>
      <div className="chat-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="chat-dialog-header">
          <h2>Nueva conversación</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>

        <div className="chat-dialog-tabs">
          <button
            type="button"
            className={mode === 'dm' ? 'active' : ''}
            onClick={() => {
              setMode('dm');
              setSelected([]);
            }}
          >
            <MessageCircleIcon /> Mensaje directo
          </button>
          <button
            type="button"
            className={mode === 'group' ? 'active' : ''}
            onClick={() => {
              setMode('group');
              setSelected([]);
            }}
          >
            <Users size={16} /> Grupo
          </button>
        </div>

        {mode === 'group' && (
          <input
            type="text"
            className="chat-dialog-input"
            placeholder="Nombre del grupo"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            maxLength={100}
          />
        )}

        <div className="chat-dialog-search">
          <Search size={16} />
          <input
            type="text"
            placeholder="Buscar por nombre o usuario..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>

        <div className="chat-dialog-list">
          {results.length === 0 && search.trim() && (
            <div className="chat-dialog-empty">No se encontraron usuarios</div>
          )}
          {results.length === 0 && !search.trim() && (
            <div className="chat-dialog-empty">Escribe para buscar usuarios</div>
          )}
          {results.map((user) => {
            const isSelected = selected.some((u) => u.id === user.id);
            return (
              <button
                key={user.id}
                type="button"
                className={`chat-dialog-user ${isSelected ? 'selected' : ''}`}
                onClick={() => toggleSelect(user)}
              >
                <div className="chat-dialog-user-avatar">
                  {user.name.slice(0, 2).toUpperCase()}
                  {user.status === 'online' && <span className="chat-sidebar-presence online" />}
                </div>
                <div className="chat-dialog-user-info">
                  <div className="chat-dialog-user-name">{user.name}</div>
                  <div className="chat-dialog-user-username">@{user.username}</div>
                </div>
                {isSelected && <Check size={18} className="chat-dialog-check" />}
              </button>
            );
          })}
        </div>

        {selected.length > 0 && (
          <div className="chat-dialog-selected">
            {selected.map((u) => (
              <span key={u.id} className="chat-dialog-chip">
                {u.name}
                <button
                  type="button"
                  onClick={() => toggleSelect(u)}
                  aria-label={`Quitar ${u.name}`}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        {error && <div className="chat-dialog-error">{error}</div>}

        <div className="chat-dialog-footer">
          <button type="button" className="chat-dialog-cancel" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="chat-dialog-create"
            disabled={loading || selected.length === 0}
            onClick={handleCreate}
          >
            {loading ? 'Creando...' : mode === 'dm' ? 'Iniciar chat' : 'Crear grupo'}
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageCircleIcon() {
  return <MessageCircleIconInner />;
}

function MessageCircleIconInner() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}
