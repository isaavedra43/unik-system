'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X, Loader2 } from 'lucide-react';

export interface ChatSearchDialogProps {
  open: boolean;
  onClose: () => void;
  onSelectChannel: (channelId: string) => void;
}

interface SearchResult {
  messageId: string;
  channelId: string;
  channelName: string;
  senderName: string;
  content: string;
  createdAt: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function ChatSearchDialog({ open, onClose, onSelectChannel }: ChatSearchDialogProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when opened
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/app/chat/api/search?query=${encodeURIComponent(trimmed)}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Error en la búsqueda');
        }
        const data = await res.json();
        setResults(Array.isArray(data.data) ? data.data : []);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error en la búsqueda');
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, open]);

  const handleSelect = useCallback(
    (result: SearchResult) => {
      onSelectChannel(result.channelId);
      onClose();
    },
    [onSelectChannel, onClose]
  );

  const handleClose = useCallback(() => {
    setQuery('');
    setResults([]);
    setError(null);
    onClose();
  }, [onClose]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="chat-dialog-overlay" onClick={handleClose}>
      <div className="chat-dialog chat-search-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="chat-dialog-header">
          <h2>Buscar mensajes</h2>
          <button type="button" onClick={handleClose} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>

        <div className="chat-search-input">
          <Search size={18} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Escribe para buscar..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {loading && <Loader2 size={18} className="spin" />}
        </div>

        <div className="chat-search-results">
          {error && <div className="chat-dialog-error">{error}</div>}
          {!error && !loading && query.trim().length >= 2 && results.length === 0 && (
            <div className="chat-dialog-empty">No se encontraron mensajes</div>
          )}
          {!error && query.trim().length < 2 && (
            <div className="chat-dialog-empty">Escribe al menos 2 caracteres</div>
          )}
          {results.map((result) => (
            <button
              key={result.messageId}
              type="button"
              className="chat-search-result"
              onClick={() => handleSelect(result)}
            >
              <span className="chat-search-result-channel">{result.channelName}</span>
              <span className="chat-search-result-sender">{result.senderName}</span>
              <span className="chat-search-result-preview">{result.content.slice(0, 120)}</span>
              <span className="chat-search-result-date">{formatDate(result.createdAt)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
