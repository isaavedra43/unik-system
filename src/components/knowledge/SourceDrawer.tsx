'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Download,
  ExternalLink,
  FileUp,
  Link2,
  Loader2,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Type,
} from 'lucide-react';
import { Badge, Button, Drawer, Modal } from '@/components/ui';
import { uploadFile } from '@/lib/upload-client';
import {
  ACCEPT_ATTR,
  CATEGORY_OPTIONS,
  KIND_LABEL,
  api,
  currentVersion,
  displayStatus,
  errorMessage,
  fold,
  formatBytes,
  formatDate,
  hostOf,
  mimeForFile,
  rowKind,
  splitTags,
  validateFile,
  type Chunk,
  type DisplayStatus,
  type Preview,
  type SourceDetail,
  type SourceRow,
  type VersionRow,
} from './knowledge-api';

type Section = 'preview' | 'chunks' | 'versions' | 'settings';

interface SettingsForm {
  title: string;
  description: string;
  category: string;
  visibility: 'internal' | 'publishable';
  tags: string;
  useWhen: string;
  expiresAt: string;
}

function formFrom(s: SourceRow): SettingsForm {
  return {
    title: s.title,
    description: s.description ?? '',
    category: s.category ?? '',
    visibility: s.visibility,
    tags: s.tags.join(', '),
    useWhen: s.useWhen ?? '',
    expiresAt: s.expiresAt ? s.expiresAt.slice(0, 10) : '',
  };
}

interface SourceDrawerProps {
  source: SourceRow | null;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  onNotice: (message: string) => void;
}

const BASE = '/app/admin/knowledge/api/sources';

export function SourceDrawer({ source, onClose, onChanged, onNotice }: SourceDrawerProps) {
  const [section, setSection] = useState<Section>('preview');
  const [versionId, setVersionId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [chunks, setChunks] = useState<Chunk[] | null>(null);
  const [totalChunks, setTotalChunks] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteText, setDeleteText] = useState('');

  const sourceRef = useRef(source);
  sourceRef.current = source;
  const sourceId = source?.id ?? null;

  // Reset when another source is opened.
  useEffect(() => {
    const s = sourceRef.current;
    if (!s) return;
    setSection('preview');
    setVersionId(s.currentVersionId ?? s.versions[0]?.id ?? null);
    setForm(formFrom(s));
    setError(null);
    setConfirmDelete(false);
    setDeleteText('');
  }, [sourceId]);

  const selected = source?.versions.find((v) => v.id === versionId) ?? null;
  const loadKey = selected ? `${selected.id}:${selected.status}:${selected.chunkCount}` : null;

  // Preview + fragments of the selected version (refreshes when processing finishes).
  useEffect(() => {
    if (!sourceId || !versionId || !loadKey) {
      setPreview(null);
      setChunks(null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    setChunks(null);
    const q = `versionId=${encodeURIComponent(versionId)}`;
    api<Preview>(`${BASE}/${sourceId}/preview?${q}`)
      .then((p) => !cancelled && setPreview(p))
      .catch((e) => !cancelled && setPreview({ type: 'none', message: errorMessage(e) }));
    api<SourceDetail>(`${BASE}/${sourceId}?${q}`)
      .then((d) => {
        if (cancelled) return;
        setChunks(d.chunks);
        setTotalChunks(d.totalChunks);
      })
      .catch(() => !cancelled && setChunks([]));
    return () => {
      cancelled = true;
    };
  }, [sourceId, versionId, loadKey]);

  async function act(key: string, fn: () => Promise<void>, notice?: string): Promise<boolean> {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await onChanged();
      if (notice) onNotice(notice);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (!source || !form) return null;
  const s = source;

  const status = displayStatus(s);
  const current = currentVersion(s);
  const kind = rowKind(s);

  const approve = (v: VersionRow) =>
    act(
      'approve',
      async () => {
        await api(`${BASE}/${s.id}/approve`, { method: 'POST', body: JSON.stringify({ versionId: v.id }) });
        setVersionId(v.id);
      },
      `v${v.version} aprobada: la IA ya la usa`
    );

  const setArchived = (archived: boolean) =>
    act(
      'archive',
      async () => {
        await api(`${BASE}/${s.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: archived ? 'archived' : s.currentVersionId ? 'approved' : 'draft' }),
        });
      },
      archived ? 'Fuente archivada: la IA ya no la usa' : 'Fuente restaurada'
    );

  const saveSettings = () =>
    act(
      'save',
      async () => {
        await api(`${BASE}/${s.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: form.title.trim(),
            description: form.description,
            category: form.category || null,
            visibility: form.visibility,
            tags: splitTags(form.tags),
            useWhen: form.useWhen,
            expiresAt: form.expiresAt || null,
          }),
        });
      },
      'Cambios guardados'
    );

  const remove = async () => {
    const ok = await act('delete', async () => {
      await api(`${BASE}/${s.id}`, { method: 'DELETE' });
    }, `“${s.title}” se eliminó`);
    if (ok) {
      setConfirmDelete(false);
      onClose();
    }
  };

  const fileUrl = selected?.storageObjectId ? `/app/files/api/objects/${selected.storageObjectId}/content` : null;
  const sections: Array<{ id: Section; label: string }> = [
    { id: 'preview', label: 'Vista previa' },
    { id: 'chunks', label: `Lo que lee la IA${selected?.status === 'ready' ? ` · ${selected.chunkCount}` : ''}` },
    { id: 'versions', label: `Versiones · ${s.versions.length}` },
    { id: 'settings', label: 'Ajustes' },
  ];

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        size="xl"
        title={s.title}
        subtitle={`${KIND_LABEL[kind]} · ${s.visibility === 'publishable' ? 'Publicable' : 'Interna'} · actualizada ${formatDate(s.updatedAt)}`}
        footer={
          <div className="klib-actions-row">
            {fileUrl && (
              <a className="btn btn-secondary btn-md" href={`${fileUrl}?download=1`}>
                <Download size={16} aria-hidden="true" /> Descargar
              </a>
            )}
            {selected?.sourceUrl && (
              <a className="btn btn-secondary btn-md" href={selected.sourceUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={16} aria-hidden="true" /> Abrir {s.kind === 'website' ? 'sitio' : 'página'}
              </a>
            )}
            <Button type="button" variant="secondary" onClick={onClose}>
              Cerrar
            </Button>
          </div>
        }
      >
        <div className="klib-drawer">
          <StatusBanner source={s} status={status} busy={busy} onApprove={approve} onRestore={() => setArchived(false)} />

          {error && (
            <div className="klib-note klib-note-danger" role="alert">
              <AlertTriangle size={16} />
              <div className="klib-note-body">{error}</div>
            </div>
          )}

          <div className="tabs" role="tablist" aria-label="Secciones de la fuente">
            {sections.map((sec) => (
              <button
                key={sec.id}
                type="button"
                role="tab"
                aria-selected={section === sec.id}
                className="tab"
                onClick={() => setSection(sec.id)}
              >
                {sec.label}
              </button>
            ))}
          </div>

          {section !== 'settings' && section !== 'versions' && s.versions.length > 1 && (
            <label className="klib-inline-label">
              Versión
              <select className="klib-select" value={versionId ?? ''} onChange={(e) => setVersionId(e.target.value)}>
                {s.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version}
                    {v.id === s.currentVersionId ? ' · vigente' : ''} · {v.status === 'ready' ? 'lista' : v.status === 'processing' ? 'procesando' : 'falló'}
                  </option>
                ))}
              </select>
            </label>
          )}

          {section === 'preview' && <PreviewPane key={versionId ?? 'none'} preview={preview} version={selected} />}
          {section === 'chunks' && <ChunksPane chunks={chunks} total={totalChunks} version={selected} />}
          {section === 'versions' && (
            <VersionsPane
              source={s}
              selectedId={versionId}
              busy={busy}
              onSelect={(id) => {
                setVersionId(id);
                setSection('preview');
              }}
              onApprove={approve}
              onCreate={(key, fn, notice) => act(key, fn, notice)}
              onCreated={(id) => setVersionId(id)}
            />
          )}
          {section === 'settings' && (
            <div className="klib-stack">
              <div className="klib-form">
                <label className="klib-field klib-span">
                  <span className="klib-label">Nombre</span>
                  <input className="klib-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </label>
                <div className="klib-field klib-span">
                  <span className="klib-label">¿Quién puede recibirla?</span>
                  <div className="klib-choices" role="group" aria-label="Visibilidad">
                    <button type="button" className="klib-choice" aria-pressed={form.visibility === 'internal'} onClick={() => setForm({ ...form, visibility: 'internal' })}>
                      <span>
                        <strong>Interna</strong>
                        <span>La IA la usa para responder al equipo. Nunca sale a clientes.</span>
                      </span>
                    </button>
                    <button type="button" className="klib-choice" aria-pressed={form.visibility === 'publishable'} onClick={() => setForm({ ...form, visibility: 'publishable' })}>
                      <span>
                        <strong>Publicable</strong>
                        <span>La IA puede citarla y enviarla a clientes cuando se lo pidas.</span>
                      </span>
                    </button>
                  </div>
                </div>
                <label className="klib-field">
                  <span className="klib-label">Categoría</span>
                  <select className="klib-select klib-select-full" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                    <option value="">Sin categoría</option>
                    {CATEGORY_OPTIONS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="klib-field">
                  <span className="klib-label">Vigente hasta</span>
                  <input className="klib-input" type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
                  <span className="klib-help">Después de esta fecha la IA deja de usarla y enviarla.</span>
                </label>
                <label className="klib-field klib-span">
                  <span className="klib-label">Cuándo usarla</span>
                  <textarea
                    className="klib-textarea"
                    rows={2}
                    maxLength={500}
                    value={form.useWhen}
                    placeholder="Ej. Cuando un cliente pregunta por promociones del mes o descuentos en impermeabilizantes"
                    onChange={(e) => setForm({ ...form, useWhen: e.target.value })}
                  />
                  <span className="klib-help">La IA lo lee para elegir este archivo cuando le pides “mándale el PDF de…”.</span>
                </label>
                <label className="klib-field">
                  <span className="klib-label">Etiquetas</span>
                  <input className="klib-input" value={form.tags} placeholder="promociones, septiembre" onChange={(e) => setForm({ ...form, tags: e.target.value })} />
                  <span className="klib-help">Separadas por coma.</span>
                </label>
                <label className="klib-field">
                  <span className="klib-label">Descripción</span>
                  <input className="klib-input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </label>
              </div>
              <div className="klib-actions-row">
                <Button type="button" variant="secondary" onClick={() => setForm(formFrom(s))} disabled={busy === 'save'}>
                  Descartar
                </Button>
                <Button type="button" icon={<Save size={15} />} isLoading={busy === 'save'} disabled={form.title.trim().length < 2} onClick={() => void saveSettings()}>
                  Guardar cambios
                </Button>
              </div>

              <div className="klib-danger">
                <div>
                  <strong>{s.status === 'archived' ? 'Restaurar' : 'Archivar'}</strong>
                  <p>{s.status === 'archived' ? 'Vuelve a estar disponible para la IA.' : 'La IA deja de usarla, pero se conserva con su historial.'}</p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  icon={s.status === 'archived' ? <RotateCcw size={15} /> : <Archive size={15} />}
                  isLoading={busy === 'archive'}
                  onClick={() => void setArchived(s.status !== 'archived')}
                >
                  {s.status === 'archived' ? 'Restaurar' : 'Archivar'}
                </Button>
              </div>
              <div className="klib-danger klib-danger-strong">
                <div>
                  <strong>Eliminar para siempre</strong>
                  <p>Borra la fuente, sus {s.versions.length} versiones, lo que indexó la IA y los archivos guardados. No se puede deshacer.</p>
                </div>
                <Button type="button" variant="danger" icon={<Trash2 size={15} />} onClick={() => setConfirmDelete(true)}>
                  Eliminar
                </Button>
              </div>
            </div>
          )}

          {current && selected && selected.id !== current.id && section === 'preview' && (
            <p className="klib-foot">
              Estás viendo v{selected.version}. La IA usa v{current.version}.
            </p>
          )}
        </div>
      </Drawer>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Eliminar fuente"
        footer={
          <div className="klib-actions-row">
            <Button type="button" variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              variant="danger"
              icon={<Trash2 size={15} />}
              isLoading={busy === 'delete'}
              disabled={deleteText.trim() !== s.title.trim()}
              onClick={() => void remove()}
            >
              Eliminar para siempre
            </Button>
          </div>
        }
      >
        <div className="klib-stack">
          <p className="klib-modal-text">
            Se borrará <strong>{s.title}</strong> con todas sus versiones y archivos. La IA dejará de usarla de inmediato.
          </p>
          <label className="klib-field">
            <span className="klib-label">Escribe el nombre para confirmar</span>
            <input className="klib-input" value={deleteText} onChange={(e) => setDeleteText(e.target.value)} placeholder={s.title} autoFocus />
          </label>
        </div>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------ */

function StatusBanner({
  source,
  status,
  busy,
  onApprove,
  onRestore,
}: {
  source: SourceRow;
  status: DisplayStatus;
  busy: string | null;
  onApprove: (v: VersionRow) => void;
  onRestore: () => void;
}) {
  const latest = source.versions[0];
  const current = currentVersion(source);
  const publishable = source.visibility === 'publishable';
  const approveButton = latest ? (
    <Button type="button" size="sm" icon={<CheckCircle2 size={14} />} isLoading={busy === 'approve'} onClick={() => onApprove(latest)}>
      Aprobar v{latest.version}
    </Button>
  ) : null;

  switch (status) {
    case 'processing':
      return (
        <div className="klib-note" role="status">
          <Loader2 size={16} className="klib-spin" />
          <div className="klib-note-body">
            <strong>Procesando v{latest?.version}.</strong> {source.kind === 'website' ? 'Leyendo las páginas del sitio' : 'Leyendo el contenido'}; la IA todavía no lo usa.
            {current ? ` Mientras tanto sigue usando v${current.version}.` : ''}
          </div>
        </div>
      );
    case 'failed':
      return (
        <div className="klib-note klib-note-danger" role="alert">
          <AlertTriangle size={16} />
          <div className="klib-note-body">
            <strong>No se pudo leer.</strong> {latest?.error ?? 'Formato no legible.'} Sube otra versión en Versiones.
          </div>
        </div>
      );
    case 'review':
      return (
        <div className="klib-note klib-note-warning">
          <AlertTriangle size={16} />
          <div className="klib-note-body">
            <strong>Lista para aprobar.</strong> Revisa la vista previa y lo que lee la IA. Al aprobar, la IA podrá usarla{publishable ? ' y enviarla a clientes' : ''}.
          </div>
          <div className="klib-note-actions">{approveButton}</div>
        </div>
      );
    case 'update':
      return (
        <div className="klib-note klib-note-warning">
          <AlertTriangle size={16} />
          <div className="klib-note-body">
            <strong>v{latest?.version} está lista.</strong> La IA sigue usando v{current?.version} hasta que apruebes la nueva.
          </div>
          <div className="klib-note-actions">{approveButton}</div>
        </div>
      );
    case 'approved':
      return (
        <div className="klib-note klib-note-success">
          <CheckCircle2 size={16} />
          <div className="klib-note-body">
            <strong>Aprobada (v{current?.version}).</strong>{' '}
            {publishable
              ? current?.storageObjectId
                ? 'La IA la usa para responder y puede enviarla a clientes.'
                : 'La IA la usa para responder, también con clientes.'
              : 'La IA la usa para responder al equipo. No sale a clientes.'}
          </div>
        </div>
      );
    case 'expired':
      return (
        <div className="klib-note klib-note-danger">
          <AlertTriangle size={16} />
          <div className="klib-note-body">
            <strong>Venció el {formatDate(source.expiresAt)}.</strong> La IA ya no la usa ni la envía. Cambia la vigencia en Ajustes o sube una versión nueva.
          </div>
        </div>
      );
    case 'archived':
      return (
        <div className="klib-note klib-note-muted">
          <Archive size={16} />
          <div className="klib-note-body">
            <strong>Archivada.</strong> La IA no la usa.
          </div>
          <div className="klib-note-actions">
            <Button type="button" size="sm" variant="secondary" icon={<RotateCcw size={14} />} isLoading={busy === 'archive'} onClick={onRestore}>
              Restaurar
            </Button>
          </div>
        </div>
      );
    default:
      return (
        <div className="klib-note klib-note-muted">
          <FileUp size={16} />
          <div className="klib-note-body">
            <strong>Sin contenido.</strong> Agrega un archivo, enlace o texto en Versiones.
          </div>
        </div>
      );
  }
}

const DOC_STYLE =
  'body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#111318;max-width:780px;margin:24px auto;padding:0 24px}' +
  'table{border-collapse:collapse;margin:12px 0}td,th{border:1px solid #e4e7ec;padding:4px 8px;vertical-align:top}h1,h2,h3{line-height:1.25}a{color:#1e3a5f}';

function PreviewPane({ preview, version }: { preview: Preview | null; version: VersionRow | null }) {
  const [sheet, setSheet] = useState(0);
  if (!version) return <div className="klib-empty"><p>Esta fuente todavía no tiene contenido.</p></div>;
  if (!preview) {
    return (
      <div className="klib-empty" aria-busy="true">
        <Loader2 size={20} className="klib-spin" />
        <p>Cargando vista previa…</p>
      </div>
    );
  }
  switch (preview.type) {
    case 'pdf':
      return <iframe className="klib-frame" src={preview.url} title={`Vista previa de ${preview.fileName}`} />;
    case 'html':
      return (
        <iframe
          className="klib-frame"
          sandbox=""
          srcDoc={`<!doctype html><html><head><meta charset="utf-8"><style>${DOC_STYLE}</style></head><body>${preview.html}</body></html>`}
          title={`Vista previa de ${preview.fileName}`}
        />
      );
    case 'table': {
      const current = preview.sheets[Math.min(sheet, preview.sheets.length - 1)];
      if (!current) return <div className="klib-empty"><p>La hoja está vacía.</p></div>;
      return (
        <div className="klib-stack">
          {preview.sheets.length > 1 && (
            <div className="klib-pills" role="group" aria-label="Hojas">
              {preview.sheets.map((sh, i) => (
                <button key={`${sh.name}-${i}`} type="button" className="klib-pill" aria-pressed={i === sheet} onClick={() => setSheet(i)}>
                  {sh.name} · {sh.totalRows}
                </button>
              ))}
            </div>
          )}
          <div className="klib-sheet">
            <table>
              <thead>
                <tr>
                  <th scope="col" className="klib-sheet-n">#</th>
                  {current.headers.map((h, i) => (
                    <th key={i} scope="col">
                      {h || `Columna ${i + 1}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {current.rows.map((r, ri) => (
                  <tr key={ri}>
                    <td className="klib-sheet-n">{ri + 1}</td>
                    {r.map((c, ci) => (
                      <td key={ci} title={c}>
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="klib-foot">
            Mostrando {current.rows.length.toLocaleString('es-MX')} de {current.totalRows.toLocaleString('es-MX')} filas. La IA lee todas, con el encabezado de cada columna.
          </p>
        </div>
      );
    }
    case 'text':
      return (
        <div className="klib-stack">
          <pre className="klib-pre">{preview.text}</pre>
          {preview.truncated && <p className="klib-foot">Vista recortada; la IA lee el documento completo.</p>}
        </div>
      );
    case 'web':
      return (
        <div className="klib-stack">
          <p className="klib-foot">
            Texto leído de{' '}
            <a href={preview.url} target="_blank" rel="noopener noreferrer">
              {hostOf(preview.url)}
            </a>
            {preview.pageCount > 1 ? ` · ${preview.pageCount} páginas` : ''}
          </p>
          <pre className="klib-pre">{preview.text}</pre>
          {preview.truncated && <p className="klib-foot">Vista recortada; la IA lee todo.</p>}
        </div>
      );
    default:
      return <div className="klib-empty"><p>{preview.message}</p></div>;
  }
}

function ChunksPane({ chunks, total, version }: { chunks: Chunk[] | null; total: number; version: VersionRow | null }) {
  const [filter, setFilter] = useState('');
  const visible = useMemo(() => {
    if (!chunks) return [];
    const terms = fold(filter.trim()).split(/\s+/).filter(Boolean);
    if (terms.length === 0) return chunks;
    return chunks.filter((c) => {
      const hay = fold(`${c.section ?? ''} ${c.content}`);
      return terms.every((t) => hay.includes(t));
    });
  }, [chunks, filter]);

  if (!version) return <div className="klib-empty"><p>Sin contenido.</p></div>;
  if (version.status !== 'ready') {
    return (
      <div className="klib-empty">
        <p>{version.status === 'processing' ? 'Se está procesando; aquí verás los fragmentos en cuanto termine.' : 'Esta versión no se pudo leer.'}</p>
      </div>
    );
  }
  if (!chunks) {
    return (
      <div className="klib-empty" aria-busy="true">
        <Loader2 size={20} className="klib-spin" />
      </div>
    );
  }
  return (
    <div className="klib-stack">
      <p className="klib-foot">
        Así queda dividido el contenido para que la IA encuentre la respuesta exacta y cite la fuente. {total.toLocaleString('es-MX')} fragmentos
        {chunks.length < total ? ` (mostrando ${chunks.length})` : ''}.
      </p>
      <label className="klib-search">
        <Search size={16} aria-hidden="true" />
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Buscar dentro del contenido" aria-label="Buscar en los fragmentos" />
      </label>
      <div>
        {visible.map((c) => (
          <article key={c.ordinal} className="klib-chunk">
            <div className="klib-chunk-head">
              <span>Fragmento {c.ordinal + 1}</span>
              {c.section && <Badge variant="weak">{c.section}</Badge>}
            </div>
            <p className="klib-chunk-body">{c.content}</p>
          </article>
        ))}
        {visible.length === 0 && <div className="klib-empty"><p>Ningún fragmento contiene eso.</p></div>}
      </div>
    </div>
  );
}

function VersionsPane({
  source,
  selectedId,
  busy,
  onSelect,
  onApprove,
  onCreate,
  onCreated,
}: {
  source: SourceRow;
  selectedId: string | null;
  busy: string | null;
  onSelect: (id: string) => void;
  onApprove: (v: VersionRow) => void;
  onCreate: (key: string, fn: () => Promise<void>, notice?: string) => Promise<boolean>;
  onCreated: (id: string) => void;
}) {
  const [mode, setMode] = useState<'file' | 'url' | 'text'>(source.kind === 'url' || source.kind === 'website' ? 'url' : source.kind === 'text' ? 'text' : 'file');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [autoApprove, setAutoApprove] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const createFrom = async (body: Record<string, unknown>) => {
    const v = await api<{ id: string }>(`${BASE}/${source.id}/versions`, { method: 'POST', body: JSON.stringify({ ...body, autoApprove }) });
    onCreated(v.id);
  };

  const onFile = async (file: File) => {
    const invalid = validateFile(file);
    setFileError(invalid);
    if (invalid) return;
    await onCreate(
      'version',
      async () => {
        setPercent(0);
        try {
          const res = await uploadFile(file, {
            target: { type: 'knowledge_source', id: source.id },
            mimeType: mimeForFile(file) ?? undefined,
            onProgress: (p) => setPercent(p.percent),
          });
          await createFrom({ storageObjectId: res.objectId });
        } finally {
          setPercent(null);
        }
      },
      'Nueva versión subida: se está procesando'
    );
  };

  return (
    <div className="klib-stack">
      <ul className="klib-versions">
        {source.versions.map((v) => (
          <li key={v.id} className="klib-version" aria-current={v.id === selectedId}>
            <span className="klib-version-num">v{v.version}</span>
            <div className="klib-version-main">
              <div className="klib-version-line">
                <Badge variant={v.status === 'ready' ? 'success' : v.status === 'processing' ? 'info' : 'danger'}>
                  {v.status === 'ready' ? 'Lista' : v.status === 'processing' ? 'Procesando' : 'Falló'}
                </Badge>
                {v.id === source.currentVersionId && <Badge variant="default">Vigente</Badge>}
                {v.autoApprove && v.status === 'processing' && <Badge variant="weak">Se aprobará sola</Badge>}
              </div>
              <span className="klib-sub">
                {v.sourceUrl ? hostOf(v.sourceUrl) : v.fileName ?? 'Texto'}
                {v.sizeBytes ? ` · ${formatBytes(v.sizeBytes)}` : ''}
                {v.status === 'ready' ? ` · ${v.chunkCount} fragmentos` : ''}
                {v.pageCount > 1 ? ` · ${v.pageCount} páginas` : ''} · {formatDate(v.createdAt)}
              </span>
              {v.error && <span className="klib-sub klib-sub-danger">{v.error}</span>}
            </div>
            <div className="klib-version-actions">
              <Button type="button" size="sm" variant="ghost" onClick={() => onSelect(v.id)}>
                Ver
              </Button>
              {v.status === 'ready' && v.id !== source.currentVersionId && (
                <Button type="button" size="sm" icon={<CheckCircle2 size={14} />} isLoading={busy === 'approve'} onClick={() => onApprove(v)}>
                  Aprobar
                </Button>
              )}
            </div>
          </li>
        ))}
        {source.versions.length === 0 && <li className="klib-foot">Todavía no hay versiones.</li>}
      </ul>

      <div className="klib-subcard">
        <div className="klib-subcard-head">
          <strong>Nueva versión</strong>
          <div className="klib-segment" role="group" aria-label="Tipo de contenido">
            <button type="button" aria-pressed={mode === 'file'} onClick={() => setMode('file')}>
              <FileUp size={14} aria-hidden="true" /> Archivo
            </button>
            <button type="button" aria-pressed={mode === 'url'} onClick={() => setMode('url')}>
              <Link2 size={14} aria-hidden="true" /> Enlace
            </button>
            <button type="button" aria-pressed={mode === 'text'} onClick={() => setMode('text')}>
              <Type size={14} aria-hidden="true" /> Texto
            </button>
          </div>
        </div>
        {mode === 'file' && (
          <div className="klib-stack">
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT_ATTR}
              className="klib-visually-hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void onFile(f);
              }}
            />
            <Button type="button" variant="secondary" icon={<FileUp size={15} />} isLoading={busy === 'version'} onClick={() => inputRef.current?.click()}>
              {percent !== null ? `Subiendo ${percent}%` : 'Elegir archivo'}
            </Button>
            {percent !== null && (
              <div className="klib-progress" aria-hidden="true">
                <span style={{ width: `${percent}%` }} />
              </div>
            )}
            {fileError && <span className="klib-sub klib-sub-danger">{fileError}</span>}
          </div>
        )}
        {mode === 'url' && (
          <div className="klib-inline-form">
            <input className="klib-input" type="url" value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} aria-label="Enlace" />
            <Button
              type="button"
              isLoading={busy === 'version'}
              disabled={!/^https?:\/\/\S+\.\S+/.test(url.trim())}
              onClick={() => void onCreate('version', () => createFrom({ url: url.trim() }).then(() => setUrl('')), 'Leyendo el enlace…')}
            >
              Leer
            </Button>
          </div>
        )}
        {mode === 'text' && (
          <div className="klib-stack">
            <textarea className="klib-textarea" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Pega aquí el texto actualizado" aria-label="Texto" />
            <div className="klib-actions-row">
              <Button type="button" isLoading={busy === 'version'} disabled={text.trim().length < 10} onClick={() => void onCreate('version', () => createFrom({ text }).then(() => setText('')), 'Versión creada: procesando')}>
                Crear versión
              </Button>
            </div>
          </div>
        )}
        <label className="klib-check">
          <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
          <span>Aprobarla en cuanto termine de procesarse (reemplaza a la vigente)</span>
        </label>
      </div>
    </div>
  );
}
