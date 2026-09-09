'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Bookmark, X, Loader2 } from 'lucide-react';

export interface ChatBookmarksPanelProps {
  onClose: () => void;
}

interface BookmarkMessage {
  messageId: string;
  senderName: string;
  content: string;
  channelName?: string | null;
  createdAt: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ChatBookmarksPanel({ onClose }: ChatBookmarksPanelProps) {
  const [bookmarks, setBookmarks] = useState<BookmarkMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadBookmarks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/app/chat/api/bookmarks');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error al cargar marcadores');
      }
      const data = await res.json();
      setBookmarks(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  return (
    <div className="chat-dialog-overlay" onClick={onClose}>
      <div className="chat-dialog chat-bookmarks-panel" onClick={(e) => e.stopPropagation()}>
        <div className="chat-bookmarks-header">
          <h2>
            <Bookmark size={18} /> Marcadores
          </h2>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>

        <div className="chat-bookmarks-list">
          {loading && (
            <div className="chat-panel-loading">
              <Loader2 size={20} className="spin" /> Cargando...
            </div>
          )}
          {error && <div className="chat-dialog-error">{error}</div>}
          {!loading && !error && bookmarks.length === 0 && (
            <div className="chat-dialog-empty">No tienes marcadores</div>
          )}
          {bookmarks.map((msg) => (
            <div key={msg.messageId} className="chat-bookmarks-item">
              <span className="chat-bookmarks-sender">{msg.senderName}</span>
              {msg.channelName && <span className="chat-bookmarks-channel">{msg.channelName}</span>}
              <span className="chat-bookmarks-preview">
                {msg.content?.slice(0, 200) ?? '[Archivo]'}
              </span>
              <span className="chat-bookmarks-date">{formatDate(msg.createdAt)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
