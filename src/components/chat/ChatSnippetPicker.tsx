'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Code2, X, Plus, Loader2 } from 'lucide-react';

export interface ChatSnippetPickerProps {
  onSelect: (content: string) => void;
  onClose: () => void;
}

interface Snippet {
  id: string;
  title: string;
  content: string;
}

export function ChatSnippetPicker({ onSelect, onClose }: ChatSnippetPickerProps) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [creating, setCreating] = useState(false);

  const loadSnippets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/app/chat/api/snippets');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error al cargar snippets');
      }
      const data = await res.json();
      setSnippets(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSnippets();
  }, [loadSnippets]);

  const handleCreate = useCallback(async () => {
    const trimmedTitle = newTitle.trim();
    const trimmedContent = newContent.trim();
    if (!trimmedTitle || !trimmedContent) return;
    setCreating(true);
    try {
      const res = await fetch('/app/chat/api/snippets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmedTitle, content: trimmedContent }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error al crear snippet');
      }
      setNewTitle('');
      setNewContent('');
      setShowCreate(false);
      await loadSnippets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setCreating(false);
    }
  }, [newTitle, newContent, loadSnippets]);

  const handleSelect = useCallback(
    (content: string) => {
      onSelect(content);
      onClose();
    },
    [onSelect, onClose]
  );

  return (
    <div className="chat-dialog-overlay" onClick={onClose}>
      <div className="chat-dialog chat-snippet-picker" onClick={(e) => e.stopPropagation()}>
        <div className="chat-dialog-header">
          <h2>
            <Code2 size={20} /> Snippets
          </h2>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>

        {!showCreate ? (
          <>
            <div className="chat-snippet-list">
              {loading && (
                <div className="chat-panel-loading">
                  <Loader2 size={20} className="spin" /> Cargando...
                </div>
              )}
              {error && <div className="chat-dialog-error">{error}</div>}
              {!loading && !error && snippets.length === 0 && (
                <div className="chat-dialog-empty">No tienes snippets guardados</div>
              )}
              {snippets.map((snippet) => (
                <button
                  key={snippet.id}
                  type="button"
                  className="chat-snippet-item"
                  onClick={() => handleSelect(snippet.content)}
                >
                  <span className="chat-snippet-title">{snippet.title}</span>
                  <span className="chat-snippet-preview">{snippet.content.slice(0, 120)}</span>
                </button>
              ))}
            </div>

            <div className="chat-dialog-footer">
              <button
                type="button"
                className="chat-snippet-create"
                onClick={() => setShowCreate(true)}
              >
                <Plus size={16} /> Nuevo snippet
              </button>
            </div>
          </>
        ) : (
          <div className="chat-snippet-form">
            <input
              type="text"
              className="chat-snippet-form-title"
              placeholder="Título"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              maxLength={100}
              autoFocus
            />
            <textarea
              className="chat-snippet-form-content"
              placeholder="Contenido del snippet..."
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              rows={6}
            />
            {error && <div className="chat-dialog-error">{error}</div>}
            <div className="chat-dialog-footer">
              <button
                type="button"
                className="chat-dialog-cancel"
                onClick={() => {
                  setShowCreate(false);
                  setNewTitle('');
                  setNewContent('');
                  setError(null);
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="chat-dialog-create"
                disabled={creating || !newTitle.trim() || !newContent.trim()}
                onClick={handleCreate}
              >
                {creating ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
