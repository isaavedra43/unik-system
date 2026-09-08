'use client';

import React, { useEffect, useState, useCallback } from 'react';

interface ToolCallRow {
  id: string;
  toolName: string;
  args: unknown;
  result: unknown;
  durationMs: number;
  success: boolean;
  errorCode: string | null;
  createdAt: string;
  userName: string;
  username: string;
  conversationTitle: string;
}

export function AssistantAdminToolCalls() {
  const [data, setData] = useState<ToolCallRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [toolName, setToolName] = useState('');
  const [successFilter, setSuccessFilter] = useState<'all' | 'success' | 'error'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (toolName) params.set('toolName', toolName);
      if (successFilter === 'success') params.set('success', 'true');
      if (successFilter === 'error') params.set('success', 'false');
      const res = await fetch(`/app/admin/assistant/api/tool-calls?${params}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.data ?? []);
        setTotal(json.total ?? 0);
      }
    } finally {
      setLoading(false);
    }
  }, [page, toolName, successFilter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="assistant-admin-tab">
      <div className="assistant-admin-filters">
        <input
          type="text"
          placeholder="Nombre del tool…"
          value={toolName}
          onChange={(e) => { setToolName(e.target.value); setPage(1); }}
          className="assistant-admin-filter-input"
        />
        <select
          value={successFilter}
          onChange={(e) => { setSuccessFilter(e.target.value as 'all' | 'success' | 'error'); setPage(1); }}
        >
          <option value="all">Todos</option>
          <option value="success">Exitosos</option>
          <option value="error">Errores</option>
        </select>
      </div>
      <div className="assistant-admin-table-wrap">
        {loading && <div className="assistant-admin-loading">Cargando…</div>}
        {!loading && data.length === 0 && <div className="assistant-admin-empty">No hay tool calls</div>}
        {!loading && data.length > 0 && (
          <table className="assistant-admin-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Usuario</th>
                <th>Conversación</th>
                <th>Estado</th>
                <th>Duración</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {data.map((tc) => (
                <tr key={tc.id}>
                  <td>{tc.toolName}</td>
                  <td>{tc.userName} <span className="assistant-admin-muted">@{tc.username}</span></td>
                  <td>{tc.conversationTitle}</td>
                  <td>
                    <span className={`assistant-admin-badge ${tc.success ? 'assistant-admin-badge-success' : 'assistant-admin-badge-error'}`}>
                      {tc.success ? 'OK' : 'Error'}
                    </span>
                  </td>
                  <td>{tc.durationMs}ms</td>
                  <td>{new Date(tc.createdAt).toLocaleString('es-MX')}</td>
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
