'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Plus, Search, Upload } from 'lucide-react';
import { uploadFile, UploadError } from '@/lib/upload-client';

interface VersionRow {
  id: string;
  version: number;
  status: string;
  chunkCount: number;
  error: string | null;
  storageObjectId: string | null;
  sourceUrl: string | null;
  createdAt: string;
}

interface SourceRow {
  id: string;
  title: string;
  description: string | null;
  kind: string;
  visibility: string;
  status: string;
  currentVersionId: string | null;
  tags: string[];
  approvedAt: string | null;
  updatedAt: string;
  versions: VersionRow[];
}

interface Hit {
  sourceId: string;
  title: string;
  visibility: string;
  version: number;
  section: string | null;
  excerpt: string;
  rank: number;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

function badge(status: string): string {
  if (status === 'approved' || status === 'ready')
    return 'assistant-admin-badge assistant-admin-badge-success';
  if (status === 'failed' || status === 'archived')
    return 'assistant-admin-badge assistant-admin-badge-error';
  return 'assistant-admin-badge';
}

export function KnowledgeAdminPanel() {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: '',
    description: '',
    kind: 'document',
    visibility: 'internal',
    tags: '',
  });
  const [textFor, setTextFor] = useState<{ id: string; text: string; url: string } | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);

  const load = useCallback(async () => {
    try {
      const data = await api<{ sources: SourceRow[] }>('/app/admin/knowledge/api/sources');
      setSources(data.sources);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  async function run(fn: () => Promise<void>, ok?: string) {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  }

  async function createSource() {
    await run(async () => {
      await api('/app/admin/knowledge/api/sources', {
        method: 'POST',
        body: JSON.stringify({
          title: form.title,
          description: form.description || undefined,
          kind: form.kind,
          visibility: form.visibility,
          tags: form.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      });
      setForm({ title: '', description: '', kind: 'document', visibility: 'internal', tags: '' });
    }, 'Fuente creada (borrador)');
  }

  async function upload(sourceId: string, file: File) {
    setUploading(sourceId);
    setError(null);
    try {
      const result = await uploadFile(file, { target: { type: 'knowledge_source', id: sourceId } });
      await api(`/app/admin/knowledge/api/sources/${sourceId}/versions`, {
        method: 'POST',
        body: JSON.stringify({ storageObjectId: result.objectId }),
      });
      setNotice('Archivo validado; procesando versión');
      await load();
    } catch (e) {
      setError(e instanceof UploadError || e instanceof Error ? e.message : 'Error');
    } finally {
      setUploading(null);
    }
  }

  async function addTextOrUrl() {
    if (!textFor) return;
    const { id, text, url } = textFor;
    await run(async () => {
      await api(`/app/admin/knowledge/api/sources/${id}/versions`, {
        method: 'POST',
        body: JSON.stringify(url ? { url } : { text }),
      });
      setTextFor(null);
    }, 'Versión creada; procesando');
  }

  async function approve(sourceId: string, versionId: string) {
    await run(async () => {
      await api(`/app/admin/knowledge/api/sources/${sourceId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ versionId }),
      });
    }, 'Versión aprobada: ya es citable por el asistente');
  }

  async function setStatus(sourceId: string, status: string) {
    await run(async () => {
      await api(`/app/admin/knowledge/api/sources/${sourceId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
    }, `Fuente ${status}`);
  }

  async function setVisibility(sourceId: string, visibility: string) {
    await run(async () => {
      await api(`/app/admin/knowledge/api/sources/${sourceId}`, {
        method: 'PATCH',
        body: JSON.stringify({ visibility }),
      });
    });
  }

  async function search() {
    try {
      const r = await api<{ hits: Hit[] }>(
        `/app/assistant/api/knowledge/search?q=${encodeURIComponent(query)}`
      );
      setHits(r.hits);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  }

  if (loading) return <div className="assistant-admin-loading">Cargando…</div>;

  return (
    <div className="assistant-admin-panel">
      {error && (
        <div className="assistant-admin-error" role="alert">
          <AlertCircle size={16} /> {error}
        </div>
      )}
      {notice && (
        <div className="assistant-admin-success" role="status">
          <CheckCircle2 size={16} /> {notice}
        </div>
      )}

      <div className="assistant-admin-section">
        <h3 className="assistant-admin-section-title">Nueva fuente</h3>
        <div className="assistant-admin-config-grid">
          <div className="assistant-admin-config-field">
            <label htmlFor="ks-title">Título</label>
            <input
              id="ks-title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="ks-kind">Tipo</label>
            <select
              id="ks-kind"
              className="assistant-admin-select"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              <option value="document">Documento</option>
              <option value="text">Texto</option>
              <option value="url">URL</option>
            </select>
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="ks-vis">Visibilidad</label>
            <select
              id="ks-vis"
              className="assistant-admin-select"
              value={form.visibility}
              onChange={(e) => setForm({ ...form, visibility: e.target.value })}
            >
              <option value="internal">Interna</option>
              <option value="publishable">Publicable</option>
            </select>
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="ks-tags">Etiquetas (coma)</label>
            <input
              id="ks-tags"
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
            />
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="ks-desc">Descripción</label>
            <input
              id="ks-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
        </div>
        <button
          type="button"
          className="assistant-admin-save-btn"
          disabled={form.title.length < 2}
          onClick={createSource}
        >
          <Plus size={14} /> Crear fuente
        </button>
      </div>

      <div className="assistant-admin-section">
        <h3 className="assistant-admin-section-title">Fuentes</h3>
        <div className="assistant-admin-table-wrap">
          <table className="assistant-admin-table">
            <thead>
              <tr>
                <th>Título</th>
                <th>Tipo</th>
                <th>Visibilidad</th>
                <th>Estado</th>
                <th>Versiones</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.title}
                    <div className="assistant-admin-list-meta">
                      {s.description ?? ''} {s.tags.length > 0 ? `· ${s.tags.join(', ')}` : ''}
                    </div>
                  </td>
                  <td>{s.kind}</td>
                  <td>
                    <select
                      className="assistant-admin-select"
                      value={s.visibility}
                      onChange={(e) => setVisibility(s.id, e.target.value)}
                      aria-label={`Visibilidad de ${s.title}`}
                    >
                      <option value="internal">interna</option>
                      <option value="publishable">publicable</option>
                    </select>
                  </td>
                  <td>
                    <span className={badge(s.status)}>{s.status}</span>
                  </td>
                  <td>
                    {s.versions.map((v) => (
                      <div key={v.id} className="assistant-admin-list-meta">
                        v{v.version} <span className={badge(v.status)}>{v.status}</span>{' '}
                        {v.chunkCount} fragmentos {s.currentVersionId === v.id ? '· vigente' : ''}
                        {v.error ? ` · ${v.error}` : ''}
                        {v.status === 'ready' && s.currentVersionId !== v.id && (
                          <button
                            type="button"
                            className="assistant-admin-test-btn"
                            onClick={() => approve(s.id, v.id)}
                          >
                            Aprobar
                          </button>
                        )}
                      </div>
                    ))}
                    {s.versions.length === 0 && (
                      <span className="assistant-admin-muted">sin versiones</span>
                    )}
                  </td>
                  <td>
                    <div className="assistant-admin-filters">
                      <label className="assistant-admin-test-btn">
                        <Upload size={14} /> {uploading === s.id ? 'Subiendo…' : 'Subir archivo'}
                        <input
                          type="file"
                          accept=".pdf,.txt,.md,.csv,.docx"
                          style={{ display: 'none' }}
                          disabled={uploading === s.id}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) upload(s.id, f);
                            e.target.value = '';
                          }}
                          aria-label={`Subir archivo a ${s.title}`}
                        />
                      </label>
                      <button
                        type="button"
                        className="assistant-admin-test-btn"
                        onClick={() => setTextFor({ id: s.id, text: '', url: '' })}
                      >
                        Texto / URL
                      </button>
                      {s.status !== 'archived' && (
                        <button
                          type="button"
                          className="assistant-admin-test-btn"
                          onClick={() => setStatus(s.id, 'archived')}
                        >
                          Archivar
                        </button>
                      )}
                      {s.status === 'archived' && (
                        <button
                          type="button"
                          className="assistant-admin-test-btn"
                          onClick={() => setStatus(s.id, s.currentVersionId ? 'approved' : 'draft')}
                        >
                          Restaurar
                        </button>
                      )}
                    </div>
                    {textFor?.id === s.id && (
                      <div className="assistant-admin-config-grid">
                        <div className="assistant-admin-config-field">
                          <label htmlFor={`url-${s.id}`}>URL (HTTPS)</label>
                          <input
                            id={`url-${s.id}`}
                            value={textFor.url}
                            onChange={(e) => setTextFor({ ...textFor, url: e.target.value })}
                          />
                        </div>
                        <div className="assistant-admin-config-field">
                          <label htmlFor={`txt-${s.id}`}>Texto</label>
                          <textarea
                            id={`txt-${s.id}`}
                            className="assistant-admin-filter-input"
                            rows={4}
                            value={textFor.text}
                            onChange={(e) => setTextFor({ ...textFor, text: e.target.value })}
                          />
                        </div>
                        <div className="assistant-admin-config-field">
                          <label>&nbsp;</label>
                          <button
                            type="button"
                            className="assistant-admin-save-btn"
                            disabled={!textFor.text && !textFor.url}
                            onClick={addTextOrUrl}
                          >
                            Crear versión
                          </button>
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {sources.length === 0 && (
                <tr>
                  <td colSpan={6} className="assistant-admin-muted">
                    Sin fuentes todavía
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="assistant-admin-section">
        <h3 className="assistant-admin-section-title">
          Probar búsqueda (solo versiones aprobadas)
        </h3>
        <div className="assistant-admin-filters">
          <input
            className="assistant-admin-filter-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="garantía instalación"
            aria-label="Consulta"
          />
          <button
            type="button"
            className="assistant-admin-test-btn"
            onClick={search}
            disabled={query.trim().length < 2}
          >
            <Search size={14} /> Buscar
          </button>
        </div>
        <div className="assistant-admin-list">
          {hits.map((h, i) => (
            <div
              key={i}
              className="assistant-admin-list-item"
              style={{ alignItems: 'flex-start', flexDirection: 'column' }}
            >
              <div className="assistant-admin-list-name">
                {h.title} · v{h.version} ·{' '}
                <span className="assistant-admin-badge">{h.visibility}</span>{' '}
                {h.section ? `· ${h.section}` : ''}
              </div>
              <div className="assistant-admin-list-meta">{h.excerpt}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
