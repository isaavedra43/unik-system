'use client';

import React, { useEffect, useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import { uploadFile } from '@/lib/upload-client';
import type { InternalRequestDTO } from '@/modules/comms/requests-service';
import type { ResponsibleDTO } from '@/modules/comms/responsibles-service';
import { apiJson } from '@/components/inbox/inbox-types';

interface Props {
  onCreated: (request: InternalRequestDTO) => void;
  onCancel: () => void;
  defaults?: { contactId?: string | null; commConversationId?: string | null; title?: string };
}

interface UploadedFile {
  objectId: string | null;
  name: string;
  error: string | null;
}

export function RequestForm({ onCreated, onCancel, defaults }: Props) {
  const [responsibles, setResponsibles] = useState<ResponsibleDTO[]>([]);
  const [type, setType] = useState('');
  const [title, setTitle] = useState(defaults?.title ?? '');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<'normal' | 'high' | 'urgent'>('normal');
  const [dueAt, setDueAt] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [facts, setFacts] = useState<Array<{ key: string; value: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiJson<{ responsibles: ResponsibleDTO[] }>('/app/admin/comms/api/responsibles')
      .then((d) => setResponsibles(d.responsibles))
      .catch(() => setResponsibles([]));
  }, []);

  const matched = responsibles.find(
    (r) => r.area === type.trim().toLowerCase().replace(/\s+/g, '_')
  );

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    for (const file of Array.from(list)) {
      const entry: UploadedFile = { objectId: null, name: file.name, error: null };
      setFiles((prev) => [...prev, entry]);
      try {
        const result = await uploadFile(file, { target: { type: 'internal_request', id: 'new' } });
        setFiles((prev) =>
          prev.map((f) => (f === entry ? { ...f, objectId: result.objectId } : f))
        );
      } catch (err) {
        setFiles((prev) =>
          prev.map((f) =>
            f === entry ? { ...f, error: err instanceof Error ? err.message : 'Error' } : f
          )
        );
      }
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const data = await apiJson<{ request: InternalRequestDTO }>('/app/requests/api', {
        method: 'POST',
        body: JSON.stringify({
          type: type.trim(),
          title: title.trim(),
          description: description.trim() || undefined,
          priority,
          dueAt: dueAt ? new Date(dueAt).toISOString() : null,
          fileIds: files.map((f) => f.objectId).filter((id): id is string => Boolean(id)),
          contactId: defaults?.contactId ?? null,
          commConversationId: defaults?.commConversationId ?? null,
          facts: facts
            .filter((f) => f.key.trim() && f.value.trim())
            .map((f) => ({ ...f, source: 'user' })),
        }),
      });
      onCreated(data.request);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear la solicitud');
    } finally {
      setSaving(false);
    }
  };

  const uploading = files.some((f) => !f.objectId && !f.error);

  return (
    <form
      onSubmit={submit}
      className="assistant-admin-config-grid"
      style={{ display: 'grid', gap: 12 }}
    >
      {error && (
        <div className="assistant-admin-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-field">
        <label htmlFor="req-type">Tipo / área</label>
        <input
          id="req-type"
          className="input"
          list="req-areas"
          value={type}
          onChange={(e) => setType(e.target.value)}
          required
          placeholder="ventas, instalaciones, cobranza, soporte…"
        />
        <datalist id="req-areas">
          {responsibles.map((r) => (
            <option key={r.id} value={r.area}>
              {r.label}
            </option>
          ))}
        </datalist>
        <small className="assistant-admin-config-hint">
          {matched
            ? `Se asignará automáticamente a ${matched.userName ?? matched.label}${matched.backupUserName ? ` (respaldo: ${matched.backupUserName})` : ''}.`
            : 'Si el área tiene responsable, la solicitud se asigna sola.'}
        </small>
      </div>
      <div className="form-field">
        <label htmlFor="req-title">Título</label>
        <input
          id="req-title"
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          minLength={3}
          maxLength={200}
        />
      </div>
      <div className="form-field">
        <label htmlFor="req-desc">Descripción</label>
        <textarea
          id="req-desc"
          className="input"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={5000}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="form-field">
          <label htmlFor="req-priority">Prioridad</label>
          <select
            id="req-priority"
            className="select"
            value={priority}
            onChange={(e) => setPriority(e.target.value as typeof priority)}
          >
            <option value="normal">Normal</option>
            <option value="high">Alta</option>
            <option value="urgent">Urgente</option>
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="req-due">Fecha límite</label>
          <input
            id="req-due"
            className="input"
            type="datetime-local"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
        </div>
      </div>
      <div className="form-field">
        <label>Expediente inicial (hechos)</label>
        {facts.map((f, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input
              className="input"
              aria-label="Dato"
              placeholder="Dato (p. ej. dirección)"
              value={f.key}
              onChange={(e) =>
                setFacts((prev) =>
                  prev.map((x, j) => (j === i ? { ...x, key: e.target.value } : x))
                )
              }
              style={{ flex: 1 }}
            />
            <input
              className="input"
              aria-label="Valor"
              placeholder="Valor"
              value={f.value}
              onChange={(e) =>
                setFacts((prev) =>
                  prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x))
                )
              }
              style={{ flex: 2 }}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label="Quitar dato"
              onClick={() => setFacts((prev) => prev.filter((_, j) => j !== i))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setFacts((prev) => [...prev, { key: '', value: '' }])}
        >
          + Añadir dato
        </button>
      </div>
      <div className="form-field">
        <label htmlFor="req-files">Archivos</label>
        <input id="req-files" type="file" multiple onChange={(e) => addFiles(e.target.files)} />
        {files.length > 0 && (
          <ul
            style={{
              margin: '6px 0 0',
              padding: 0,
              listStyle: 'none',
              display: 'flex',
              gap: 6,
              flexWrap: 'wrap',
            }}
          >
            {files.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                className="badge badge-weak"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <Paperclip size={12} /> {f.name}{' '}
                {f.error ? `· ${f.error}` : f.objectId ? '' : '· subiendo…'}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>
          Cancelar
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={saving || uploading || !type.trim() || title.trim().length < 3}
        >
          {saving ? 'Creando…' : 'Crear solicitud'}
        </button>
      </div>
    </form>
  );
}
