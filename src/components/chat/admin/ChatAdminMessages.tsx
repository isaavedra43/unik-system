'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Search } from 'lucide-react';

interface MessageResult {
  id: string;
  channelId: string;
  channelName: string;
  sender: string;
  content: string;
  createdAt: string;
}

export function ChatAdminMessages() {
  const [query, setQuery] = useState('');
  const [channelId, setChannelId] = useState('');
  const [results, setResults] = useState<MessageResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const search = useCallback(async () => {
    if (!query.trim()) {
      setResults([]);
      setHasSearched(false);
      return;
    }
    setLoading(true);
    setError(null);
    setHasSearched(true);
    try {
      const params = new URLSearchParams({ query });
      if (channelId) params.set('channelId', channelId);
      const res = await fetch(`/app/admin/chat/api/messages?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setResults(json.messages ?? []);
      } else {
        setError('No se pudo completar la búsqueda');
      }
    } catch {
      setError('No se pudo completar la búsqueda');
    } finally {
      setLoading(false);
    }
  }, [query, channelId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      search();
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  return (
    <div className="chat-admin-messages">
      <div className="chat-admin-search">
        <Search size={16} />
        <input
          type="text"
          placeholder="Buscar mensajes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          aria-label="Filtrar por canal"
        >
          <option value="">Todos los canales</option>
        </select>
      </div>

      {loading && <div className="chat-admin-loading">Buscando…</div>}
      {error && <div className="chat-admin-error">{error}</div>}
      {!loading && !error && hasSearched && (
        <table className="chat-admin-table">
          <thead>
            <tr>
              <th>Canal</th>
              <th>Remitente</th>
              <th>Contenido</th>
              <th>Fecha</th>
            </tr>
          </thead>
          <tbody>
            {results.length === 0 && (
              <tr>
                <td colSpan={4} className="chat-admin-empty">
                  Sin resultados
                </td>
              </tr>
            )}
            {results.map((m) => (
              <tr key={m.id}>
                <td>{m.channelName}</td>
                <td>{m.sender}</td>
                <td className="chat-admin-message-preview">{m.content}</td>
                <td>{new Date(m.createdAt).toLocaleString('es-MX')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!loading && !error && !hasSearched && (
        <div className="chat-admin-empty">Escribe para buscar mensajes</div>
      )}
    </div>
  );
}
