'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import { uploadFile } from '@/lib/upload-client';
import type { InternalRequestDTO } from '@/modules/comms/requests-service';
import { apiJson, formatDateTime } from '@/components/inbox/inbox-types';
import { REQUEST_STATUS_LABELS } from './RequestsPageClient';

interface Props {
  requestId: string;
  user: { id: string; isAdmin: boolean };
  onChanged: (request: InternalRequestDTO) => void;
}

const EVENT_LABELS: Record<string, string> = {
  created: 'Creada',
  assigned: 'Asignación',
  status_changed: 'Cambio de estado',
  comment: 'Comentario',
  file_added: 'Archivos',
  ai_note: 'Nota de IA',
};

export function RequestDetail({ requestId, user, onChanged }: Props) {
  const [request, setRequest] = useState<InternalRequestDTO | null>(null);
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [fact, setFact] = useState({ key: '', value: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiJson<{ request: InternalRequestDTO }>(`/app/requests/api/${requestId}`);
      setRequest(data.request);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar');
    }
  }, [requestId]);

  useEffect(() => {
    void load();
    apiJson<{ users: Array<{ id: string; name: string }> }>('/app/inbox/api/users')
      .then((d) => setUsers(d.users))
      .catch(() => setUsers([]));
  }, [load]);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const data = await apiJson<{ request: InternalRequestDTO }>(
        `/app/requests/api/${requestId}`,
        { method: 'PATCH', body: JSON.stringify(body) }
      );
      setRequest(data.request);
      onChanged(data.request);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo actualizar');
    } finally {
      setBusy(false);
    }
  };

  const addComment = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await apiJson(`/app/requests/api/${requestId}/events`, {
        method: 'POST',
        body: JSON.stringify({ type: 'comment', body: comment }),
      });
      setComment('');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo comentar');
    } finally {
      setBusy(false);
    }
  };

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    const ids: string[] = [];
    for (const file of Array.from(list)) {
      try {
        const result = await uploadFile(file, {
          target: { type: 'internal_request', id: requestId },
        });
        ids.push(result.objectId);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `No se pudo subir ${file.name}`);
      }
    }
    if (ids.length > 0) await patch({ addFileIds: ids });
  };

  if (error)
    return (
      <div className="assistant-admin-error" role="alert">
        {error}
      </div>
    );
  if (!request) return <div className="assistant-admin-loading">Cargando…</div>;

  const canEdit =
    user.isAdmin || request.requesterUserId === user.id || request.assigneeUserId === user.id;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div>
        <h3 style={{ margin: 0 }}>{request.title}</h3>
        <div
          className="assistant-admin-list-meta"
          style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}
        >
          <span className="badge badge-weak">{request.type}</span>
          <span className="badge badge-info">
            {REQUEST_STATUS_LABELS[request.status] ?? request.status}
          </span>
          <span>
            Solicitó {request.requesterName ?? '—'} · {formatDateTime(request.createdAt)}
          </span>
          {request.contactName && <span>· Contacto: {request.contactName}</span>}
          {request.commConversationId && (
            <a
              href={`/app/inbox?conversation=${request.commConversationId}`}
              className="badge badge-weak"
            >
              Ver conversación
            </a>
          )}
        </div>
        {request.description && (
          <p style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{request.description}</p>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 10,
        }}
      >
        <div className="form-field">
          <label htmlFor="rd-status">Estado</label>
          <select
            id="rd-status"
            className="select"
            value={request.status}
            disabled={!canEdit || busy}
            onChange={(e) => patch({ status: e.target.value })}
          >
            {Object.entries(REQUEST_STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="rd-assignee">Asignada a</label>
          <select
            id="rd-assignee"
            className="select"
            value={request.assigneeUserId ?? ''}
            disabled={!canEdit || busy}
            onChange={(e) => patch({ assigneeUserId: e.target.value || null })}
          >
            <option value="">Sin asignar</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="rd-priority">Prioridad</label>
          <select
            id="rd-priority"
            className="select"
            value={request.priority}
            disabled={!canEdit || busy}
            onChange={(e) => patch({ priority: e.target.value })}
          >
            <option value="normal">Normal</option>
            <option value="high">Alta</option>
            <option value="urgent">Urgente</option>
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="rd-due">Vence</label>
          <input
            id="rd-due"
            className="input"
            type="datetime-local"
            disabled={!canEdit || busy}
            value={request.dueAt ? request.dueAt.slice(0, 16) : ''}
            onChange={(e) =>
              patch({ dueAt: e.target.value ? new Date(e.target.value).toISOString() : null })
            }
          />
        </div>
      </div>

      <section aria-label="Expediente" className="assistant-admin-section">
        <h4 className="assistant-admin-section-title">Expediente</h4>
        {request.dossier.facts.length === 0 && (
          <p className="assistant-admin-muted">Sin hechos registrados todavía.</p>
        )}
        <table className="assistant-admin-table">
          <tbody>
            {request.dossier.facts.map((f, i) => (
              <tr key={`${f.key}-${i}`}>
                <td style={{ fontWeight: 600, width: '35%' }}>{f.key}</td>
                <td>{f.value}</td>
                <td className="assistant-admin-muted" style={{ whiteSpace: 'nowrap' }}>
                  {f.source === 'ai' ? 'IA' : 'Usuario'} · {formatDateTime(f.addedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {canEdit && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input
              className="input"
              aria-label="Dato"
              placeholder="Dato"
              value={fact.key}
              onChange={(e) => setFact({ ...fact, key: e.target.value })}
              style={{ flex: 1 }}
            />
            <input
              className="input"
              aria-label="Valor"
              placeholder="Valor"
              value={fact.value}
              onChange={(e) => setFact({ ...fact, value: e.target.value })}
              style={{ flex: 2 }}
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy || !fact.key.trim() || !fact.value.trim()}
              onClick={async () => {
                await patch({
                  facts: [{ key: fact.key.trim(), value: fact.value.trim(), source: 'user' }],
                });
                setFact({ key: '', value: '' });
              }}
            >
              Añadir
            </button>
          </div>
        )}
      </section>

      <section aria-label="Archivos" className="assistant-admin-section">
        <h4 className="assistant-admin-section-title">Archivos</h4>
        {request.files.length === 0 && <p className="assistant-admin-muted">Sin archivos.</p>}
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
          {request.files.map((f) => (
            <li key={f.id}>
              <a
                href={`${f.url}?download=1`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <Paperclip size={14} /> {f.name}
              </a>
            </li>
          ))}
        </ul>
        {canEdit && (
          <input
            type="file"
            multiple
            aria-label="Adjuntar archivos"
            onChange={(e) => addFiles(e.target.files)}
            style={{ marginTop: 8 }}
            disabled={busy}
          />
        )}
      </section>

      <section aria-label="Seguimiento" className="assistant-admin-section">
        <h4 className="assistant-admin-section-title">Seguimiento</h4>
        <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
          {(request.events ?? []).map((e) => (
            <li key={e.id} style={{ borderLeft: '2px solid var(--unik-border)', paddingLeft: 10 }}>
              <div className="assistant-admin-list-meta">
                <span className="badge badge-weak">{EVENT_LABELS[e.type] ?? e.type}</span>{' '}
                {e.actorName ?? 'Sistema'} · {formatDateTime(e.createdAt)}
              </div>
              {e.body && (
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--unik-text-sm)' }}>
                  {e.body}
                </div>
              )}
            </li>
          ))}
        </ol>
        {canEdit && (
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <input
              className="input"
              aria-label="Comentario"
              placeholder="Añadir comentario…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addComment()}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || !comment.trim()}
              onClick={() => void addComment()}
            >
              Comentar
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
