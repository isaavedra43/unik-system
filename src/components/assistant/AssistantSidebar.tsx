'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Search, Star, Trash2, Pencil, Puzzle, SlidersHorizontal } from 'lucide-react';
import { AssistantPreferencesPanel } from '@/components/copilot/AssistantPreferencesPanel';
import Link from 'next/link';
import {
  createConversationAction,
  deleteConversationAction,
  renameConversationAction,
  toggleStarAction,
} from '@/app/app/assistant/actions';

interface ConversationItem {
  id: string;
  title: string;
  isStarred: boolean;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantSidebarProps {
  userId: string;
  activeId: string | null;
  onSelect: (id: string) => void;
}

export function AssistantSidebar({ userId: _userId, activeId, onSelect }: AssistantSidebarProps) {
  void _userId;
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [prefsOpen, setPrefsOpen] = useState(false);

  const loadConversations = useCallback(async () => {
    try {
      const url = search
        ? `/app/assistant/api/conversations?search=${encodeURIComponent(search)}`
        : '/app/assistant/api/conversations';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setConversations(data.conversations ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  async function handleNew() {
    const { id } = await createConversationAction({});
    await loadConversations();
    onSelect(id);
  }

  async function handleDelete(id: string) {
    await deleteConversationAction({ id });
    await loadConversations();
    if (activeId === id) onSelect('');
  }

  async function handleStar(id: string) {
    await toggleStarAction({ id });
    await loadConversations();
  }

  async function handleRename(id: string) {
    if (!editTitle.trim()) {
      setEditingId(null);
      return;
    }
    await renameConversationAction({ id, title: editTitle.trim() });
    setEditingId(null);
    await loadConversations();
  }

  return (
    <div className="assistant-sidebar">
      <div className="assistant-sidebar-header">
        <button type="button" className="assistant-sidebar-new" onClick={handleNew}>
          <Plus size={16} /> Nueva conversación
        </button>
        <div className="assistant-sidebar-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="Buscar…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar conversaciones"
          />
        </div>
      </div>
      <div className="assistant-sidebar-list">
        {loading && <div className="assistant-sidebar-empty">Cargando…</div>}
        {!loading && conversations.length === 0 && (
          <div className="assistant-sidebar-empty">No hay conversaciones</div>
        )}
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`assistant-sidebar-item ${activeId === c.id ? 'active' : ''}`}
            onClick={() => onSelect(c.id)}
          >
            {editingId === c.id ? (
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRename(c.id);
                  if (e.key === 'Escape') setEditingId(null);
                }}
                autoFocus
                className="assistant-sidebar-rename"
              />
            ) : (
              <>
                <div className="assistant-sidebar-item-title">
                  {c.isStarred && <Star size={12} className="assistant-sidebar-star" />}
                  {c.title}
                </div>
                <div className="assistant-sidebar-item-actions">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStar(c.id);
                    }}
                    aria-label="Marcar favorito"
                  >
                    <Star size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(c.id);
                      setEditTitle(c.title);
                    }}
                    aria-label="Renombrar"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(c.id);
                    }}
                    aria-label="Eliminar"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="assistant-sidebar-header" style={{ borderTop: '1px solid var(--unik-border)', borderBottom: 'none', marginTop: 'auto' }}>
        <button type="button" className="assistant-sidebar-new" onClick={() => setPrefsOpen(true)}>
          <SlidersHorizontal size={16} />
          <span>Preferencias y memoria</span>
        </button>
        <Link href="/app/assistant/extensions" className="assistant-sidebar-new" style={{ textDecoration: 'none' }}>
          <Puzzle size={16} />
          <span>Extensiones y skills</span>
        </Link>
      </div>
      <AssistantPreferencesPanel open={prefsOpen} onClose={() => setPrefsOpen(false)} />
    </div>
  );
}
