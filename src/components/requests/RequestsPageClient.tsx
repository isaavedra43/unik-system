'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Drawer } from '@/components/ui/composite';
import type { InternalRequestDTO } from '@/modules/comms/requests-service';
import { RequestForm } from './RequestForm';
import { RequestDetail } from './RequestDetail';
import { useInboxRealtime } from '@/components/inbox/useInboxRealtime';
import { apiJson } from '@/components/inbox/inbox-types';

export const REQUEST_STATUS_LABELS: Record<string, string> = {
  open: 'Abierta',
  in_progress: 'En curso',
  waiting: 'En espera',
  done: 'Hecha',
  cancelled: 'Cancelada',
};

const COLUMNS = ['open', 'in_progress', 'waiting', 'done'] as const;

export function RequestsPageClient({
  user,
  initialRequestId,
}: {
  user: { id: string; name: string; isAdmin: boolean };
  initialRequestId: string | null;
}) {
  const [items, setItems] = useState<InternalRequestDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<'all' | 'mine' | 'assigned'>('all');
  const [view, setView] = useState<'kanban' | 'list'>('kanban');
  const [showCancelled, setShowCancelled] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(initialRequestId);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiJson<{ items: InternalRequestDTO[] }>(
        `/app/requests/api?scope=${scope}&pageSize=200`
      );
      setItems(data.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las solicitudes');
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  useInboxRealtime([`user:${user.id}`], (event) => {
    if (event.type === 'request') {
      void load();
      if (event.payload.type === 'assigned') toast.info('Te asignaron una solicitud');
    }
  });

  const visible = items.filter((r) => showCancelled || r.status !== 'cancelled');
  const onSaved = (request: InternalRequestDTO) => {
    setItems((prev) => {
      const exists = prev.some((r) => r.id === request.id);
      return exists ? prev.map((r) => (r.id === request.id ? request : r)) : [request, ...prev];
    });
  };

  const card = (r: InternalRequestDTO) => (
    <button
      key={r.id}
      type="button"
      className="assistant-admin-list-item assistant-admin-row-clickable"
      onClick={() => setSelectedId(r.id)}
      style={{ width: '100%', textAlign: 'left', display: 'block' }}
    >
      <div className="assistant-admin-list-name">{r.title}</div>
      <div
        className="assistant-admin-list-meta"
        style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}
      >
        <span className="badge badge-weak">{r.type}</span>
        {r.priority !== 'normal' && (
          <span className="badge badge-warning">
            {r.priority === 'urgent' ? 'Urgente' : 'Alta'}
          </span>
        )}
        {r.dueAt && (
          <span
            className={`badge ${new Date(r.dueAt) < new Date() && r.status !== 'done' ? 'badge-danger' : 'badge-info'}`}
          >
            vence {new Date(r.dueAt).toLocaleDateString('es-MX')}
          </span>
        )}
        <span>{r.assigneeName ?? 'Sin asignar'}</span>
      </div>
    </button>
  );

  return (
    <div className="assistant-admin-panel">
      <div
        className="assistant-admin-filters"
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
      >
        <select
          className="select"
          aria-label="Alcance"
          value={scope}
          onChange={(e) => setScope(e.target.value as typeof scope)}
        >
          <option value="all">{user.isAdmin ? 'Todas' : 'Mías y asignadas'}</option>
          <option value="mine">Solicitadas por mí</option>
          <option value="assigned">Asignadas a mí</option>
        </select>
        <select
          className="select"
          aria-label="Vista"
          value={view}
          onChange={(e) => setView(e.target.value as typeof view)}
        >
          <option value="kanban">Tablero</option>
          <option value="list">Lista</option>
        </select>
        <label className="checkbox-row" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={showCancelled}
            onChange={(e) => setShowCancelled(e.target.checked)}
          />{' '}
          Mostrar canceladas
        </label>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void load()}
          aria-label="Actualizar"
        >
          <RefreshCw size={14} />
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setCreating(true)}
          style={{ marginLeft: 'auto' }}
        >
          <Plus size={14} /> Nueva solicitud
        </button>
      </div>

      {loading && items.length === 0 && <div className="assistant-admin-loading">Cargando…</div>}
      {error && (
        <div className="assistant-admin-error" role="alert">
          {error}
        </div>
      )}
      {!loading && !error && visible.length === 0 && (
        <div className="assistant-admin-empty">
          No hay solicitudes. Crea la primera con “Nueva solicitud”.
        </div>
      )}

      {view === 'kanban' ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: 12,
            marginTop: 12,
          }}
        >
          {COLUMNS.map((status) => {
            const column = visible.filter((r) => r.status === status);
            return (
              <section
                key={status}
                className="assistant-admin-section"
                aria-label={REQUEST_STATUS_LABELS[status]}
                style={{ minHeight: 120 }}
              >
                <h3 className="assistant-admin-section-title">
                  {REQUEST_STATUS_LABELS[status]}{' '}
                  <span className="assistant-admin-list-count">{column.length}</span>
                </h3>
                <div className="assistant-admin-list">{column.map(card)}</div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="assistant-admin-table-wrap" style={{ marginTop: 12 }}>
          <table className="assistant-admin-table">
            <thead>
              <tr>
                <th>Título</th>
                <th>Tipo</th>
                <th>Estado</th>
                <th>Prioridad</th>
                <th>Asignada a</th>
                <th>Vence</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={r.id}
                  className="assistant-admin-row-clickable"
                  onClick={() => setSelectedId(r.id)}
                >
                  <td>{r.title}</td>
                  <td>{r.type}</td>
                  <td>{REQUEST_STATUS_LABELS[r.status] ?? r.status}</td>
                  <td>{r.priority}</td>
                  <td>{r.assigneeName ?? '—'}</td>
                  <td>{r.dueAt ? new Date(r.dueAt).toLocaleDateString('es-MX') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        open={creating}
        onClose={() => setCreating(false)}
        title="Nueva solicitud interna"
        size="lg"
      >
        <RequestForm
          onCreated={(request) => {
            onSaved(request);
            setCreating(false);
            setSelectedId(request.id);
          }}
          onCancel={() => setCreating(false)}
        />
      </Drawer>

      <Drawer
        open={Boolean(selectedId)}
        onClose={() => setSelectedId(null)}
        title="Solicitud"
        size="lg"
      >
        {selectedId && (
          <RequestDetail key={selectedId} requestId={selectedId} user={user} onChanged={onSaved} />
        )}
      </Drawer>
    </div>
  );
}
