'use client';

import React, { useEffect, useState, useCallback } from 'react';

interface ApiCallRow {
  id: string;
  userId: string | null;
  conversationId: string | null;
  deployment: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  success: boolean;
  errorCode: string | null;
  finishReason: string | null;
  estimatedCostUsd: number;
  createdAt: string;
}

export function AssistantAdminApiCalls() {
  const [data, setData] = useState<ApiCallRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [deployment, setDeployment] = useState('');
  const [successFilter, setSuccessFilter] = useState<'all' | 'success' | 'error'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (deployment) params.set('deployment', deployment);
      if (successFilter === 'success') params.set('success', 'true');
      if (successFilter === 'error') params.set('success', 'false');
      const res = await fetch(`/app/admin/assistant/api/api-calls?${params}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.data ?? []);
        setTotal(json.total ?? 0);
      }
    } finally {
      setLoading(false);
    }
  }, [page, deployment, successFilter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="assistant-admin-tab">
      <div className="assistant-admin-filters">
        <input
          type="text"
          placeholder="Deployment…"
          value={deployment}
          onChange={(e) => { setDeployment(e.target.value); setPage(1); }}
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
        {!loading && data.length === 0 && <div className="assistant-admin-empty">No hay llamadas API</div>}
        {!loading && data.length > 0 && (
          <table className="assistant-admin-table">
            <thead>
              <tr>
                <th>Deployment</th>
                <th>Tokens</th>
                <th>Costo</th>
                <th>Estado</th>
                <th>Duración</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id}>
                  <td>{c.deployment}</td>
                  <td>{c.totalTokens.toLocaleString('es-MX')} <span className="assistant-admin-muted">({c.promptTokens}+{c.completionTokens})</span></td>
                  <td>${c.estimatedCostUsd.toFixed(6)}</td>
                  <td>
                    <span className={`assistant-admin-badge ${c.success ? 'assistant-admin-badge-success' : 'assistant-admin-badge-error'}`}>
                      {c.success ? 'OK' : c.errorCode ?? 'Error'}
                    </span>
                  </td>
                  <td>{c.durationMs}ms</td>
                  <td>{new Date(c.createdAt).toLocaleString('es-MX')}</td>
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
