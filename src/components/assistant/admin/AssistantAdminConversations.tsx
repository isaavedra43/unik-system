'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { ChevronRight, X } from 'lucide-react';

interface ConversationRow {
  id: string;
  userId: string;
  userName: string;
  username: string;
  title: string;
  isStarred: boolean;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ConversationDetail {
  conversation: {
    id: string;
    userName: string;
    username: string;
    title: string;
    isStarred: boolean;
    createdAt: string;
    updatedAt: string;
  };
  messages: Array<{
    id: string;
    role: string;
    content: string | null;
    toolCalls: unknown;
    toolCallRecords: Array<{
      id: string;
      toolName: string;
      args: unknown;
      result: unknown;
      durationMs: number;
      success: boolean;
      errorCode: string | null;
    }>;
    createdAt: string;
  }>;
}

export function AssistantAdminConversations() {
  const [data, setData] = useState<ConversationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (search) params.set('search', search);
      const res = await fetch(`/app/admin/assistant/api/conversations?${params}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.data ?? []);
        setTotal(json.total ?? 0);
      }
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    load();
  }, [load]);

  async function openDetail(id: string) {
    setDetailLoading(true);
    try {
      const res = await fetch(`/app/admin/assistant/api/conversations/${id}`);
      if (res.ok) {
        setDetail(await res.json());
      }
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="assistant-admin-tab">
      <div className="assistant-admin-filters">
        <input
          type="text"
          placeholder="Buscar por título…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="assistant-admin-filter-input"
        />
      </div>
      <div className="assistant-admin-table-wrap">
        {loading && <div className="assistant-admin-loading">Cargando…</div>}
        {!loading && data.length === 0 && (
          <div className="assistant-admin-empty">No hay conversaciones</div>
        )}
        {!loading && data.length > 0 && (
          <table className="assistant-admin-table">
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Título</th>
                <th>Mensajes</th>
                <th>Fecha</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id} onClick={() => openDetail(c.id)} className="assistant-admin-row-clickable">
                  <td>{c.userName} <span className="assistant-admin-muted">@{c.username}</span></td>
                  <td>{c.title} {c.isStarred && '★'}</td>
                  <td>{c.messageCount}</td>
                  <td>{new Date(c.updatedAt).toLocaleString('es-MX')}</td>
                  <td><ChevronRight size={14} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {total > 20 && (
        <div className="assistant-admin-pagination">
          <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>
            Anterior
          </button>
          <span>Página {page}</span>
          <button
            type="button"
            disabled={page * 20 >= total}
            onClick={() => setPage(page + 1)}
          >
            Siguiente
          </button>
        </div>
      )}
      {detail && (
        <div className="assistant-admin-modal-backdrop" onClick={() => setDetail(null)}>
          <div className="assistant-admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="assistant-admin-modal-header">
              <h3>{detail.conversation.title}</h3>
              <button type="button" onClick={() => setDetail(null)} aria-label="Cerrar">
                <X size={18} />
              </button>
            </div>
            <div className="assistant-admin-modal-body">
              <div className="assistant-admin-modal-meta">
                <span>Usuario: {detail.conversation.userName} (@{detail.conversation.username})</span>
                <span>Fecha: {new Date(detail.conversation.createdAt).toLocaleString('es-MX')}</span>
              </div>
              {detailLoading && <div className="assistant-admin-loading">Cargando…</div>}
              {detail.messages.map((m) => (
                <div key={m.id} className={`assistant-admin-msg assistant-admin-msg-${m.role}`}>
                  <div className="assistant-admin-msg-role">{m.role}</div>
                  <div className="assistant-admin-msg-content">
                    {m.content && <pre>{m.content}</pre>}
                    {m.toolCallRecords?.map((tc) => (
                      <div key={tc.id} className="assistant-admin-toolcall">
                        <span>{tc.toolName}</span>
                        <span>{tc.success ? '✓' : '✗'} {tc.durationMs}ms</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
