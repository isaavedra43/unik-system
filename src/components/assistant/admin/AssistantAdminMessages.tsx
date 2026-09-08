'use client';

import React, { useEffect, useState, useCallback } from 'react';

interface MessageRow {
  id: string;
  conversationId: string;
  conversationTitle: string;
  userName: string;
  username: string;
  role: string;
  content: string | null;
  createdAt: string;
}

export function AssistantAdminMessages() {
  const [query, setQuery] = useState('');
  const [data, setData] = useState<MessageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const params = new URLSearchParams({ q: query, page: String(page), pageSize: '20' });
      const res = await fetch(`/app/admin/assistant/api/messages?${params}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.data ?? []);
        setTotal(json.total ?? 0);
      }
    } finally {
      setLoading(false);
    }
  }, [query, page]);

  useEffect(() => {
    if (searched) search();
  }, [page, search, searched]);

  return (
    <div className="assistant-admin-tab">
      <div className="assistant-admin-filters">
        <input
          type="text"
          placeholder="Buscar en mensajes…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') search();
          }}
          className="assistant-admin-filter-input"
        />
        <button type="button" onClick={search} disabled={loading || !query.trim()}>
          Buscar
        </button>
      </div>
      <div className="assistant-admin-table-wrap">
        {loading && <div className="assistant-admin-loading">Buscando…</div>}
        {!loading && !searched && <div className="assistant-admin-empty">Escribe una búsqueda para ver mensajes</div>}
        {!loading && searched && data.length === 0 && (
          <div className="assistant-admin-empty">No se encontraron mensajes</div>
        )}
        {!loading && data.length > 0 && (
          <table className="assistant-admin-table">
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Rol</th>
                <th>Conversación</th>
                <th>Contenido</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.id}>
                  <td>{m.userName} <span className="assistant-admin-muted">@{m.username}</span></td>
                  <td><span className={`assistant-admin-badge assistant-admin-badge-${m.role}`}>{m.role}</span></td>
                  <td>{m.conversationTitle}</td>
                  <td className="assistant-admin-msg-preview">{m.content?.slice(0, 100) ?? '—'}</td>
                  <td>{new Date(m.createdAt).toLocaleString('es-MX')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {total > 20 && (
        <div className="assistant-admin-pagination">
          <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>Anterior</button>
          <span>Página {page}</span>
          <button type="button" disabled={page * 20 >= total} onClick={() => setPage(page + 1)}>Siguiente</button>
        </div>
      )}
    </div>
  );
}
