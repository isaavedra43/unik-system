'use client';

import React, { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileUp, Globe, Link2, Loader2, RotateCcw, Type, UploadCloud, X } from 'lucide-react';
import { Button } from '@/components/ui';
import { uploadFile } from '@/lib/upload-client';
import { fileKindOf } from '@/modules/copilot/knowledge-extract';
import { KindIcon } from './KindIcon';
import {
  ACCEPT_ATTR,
  CATEGORY_OPTIONS,
  FORMAT_LABELS,
  api,
  errorMessage,
  formatBytes,
  mimeForFile,
  splitTags,
  titleFromFileName,
  validateFile,
} from './knowledge-api';

type ItemState = 'queued' | 'uploading' | 'saving' | 'done' | 'error';

interface QueueItem {
  key: string;
  file: File;
  title: string;
  state: ItemState;
  percent: number;
  error: string | null;
  invalid: boolean;
  sourceId: string | null;
}

interface SharedSettings {
  visibility: 'internal' | 'publishable';
  category: string;
  tags: string;
  useWhen: string;
  autoApprove: boolean;
}

type Mode = 'files' | 'link' | 'text';

export function UploadPanel({ onCreated, onOpen }: { onCreated: () => Promise<void> | void; onOpen: (id: string) => void }) {
  const [mode, setMode] = useState<Mode>('files');
  const [shared, setShared] = useState<SharedSettings>({ visibility: 'internal', category: '', tags: '', useWhen: '', autoApprove: false });
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [running, setRunning] = useState(false);
  const [link, setLink] = useState({ url: '', title: '', crawl: false });
  const [text, setText] = useState({ title: '', body: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const patch = (key: string, next: Partial<QueueItem>) => setQueue((q) => q.map((i) => (i.key === key ? { ...i, ...next } : i)));

  function addFiles(list: FileList | File[]) {
    const items: QueueItem[] = Array.from(list).map((file) => {
      const error = validateFile(file);
      return {
        key: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        title: titleFromFileName(file.name),
        state: error ? 'error' : 'queued',
        percent: 0,
        error,
        invalid: Boolean(error),
        sourceId: null,
      };
    });
    setQueue((q) => [...q, ...items]);
  }

  const meta = () => ({
    visibility: shared.visibility,
    category: shared.category || null,
    tags: splitTags(shared.tags),
    useWhen: shared.useWhen.trim() || null,
    autoApprove: shared.autoApprove,
  });

  async function uploadOne(item: QueueItem) {
    patch(item.key, { state: 'uploading', percent: 0, error: null });
    try {
      const res = await uploadFile(item.file, {
        target: { type: 'knowledge_library', id: 'library' },
        mimeType: mimeForFile(item.file) ?? undefined,
        onProgress: (p) => patch(item.key, { percent: p.percent }),
      });
      patch(item.key, { state: 'saving', percent: 100 });
      const created = await api<{ id: string }>('/app/admin/knowledge/api/sources', {
        method: 'POST',
        body: JSON.stringify({ ...meta(), title: item.title.trim() || titleFromFileName(item.file.name), kind: 'document', storageObjectId: res.objectId }),
      });
      patch(item.key, { state: 'done', sourceId: created.id });
    } catch (e) {
      patch(item.key, { state: 'error', error: errorMessage(e) });
    }
  }

  async function uploadAll() {
    const pending = queue.filter((i) => i.state === 'queued');
    if (pending.length === 0) return;
    setRunning(true);
    setMessage(null);
    const workers = Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (pending.length > 0) {
        const next = pending.shift();
        if (next) await uploadOne(next);
      }
    });
    await Promise.all(workers);
    setRunning(false);
    await onCreated();
  }

  async function submit(body: Record<string, unknown>, success: string, reset: () => void) {
    setBusy(true);
    setMessage(null);
    try {
      const created = await api<{ id: string }>('/app/admin/knowledge/api/sources', { method: 'POST', body: JSON.stringify({ ...meta(), ...body }) });
      reset();
      setMessage({ tone: 'success', text: success });
      await onCreated();
      onOpen(created.id);
    } catch (e) {
      setMessage({ tone: 'danger', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  function addLink() {
    let url: URL;
    try {
      url = new URL(link.url.trim());
      if (!/^https?:$/.test(url.protocol)) throw new Error();
    } catch {
      setMessage({ tone: 'danger', text: 'Escribe un enlace completo, por ejemplo https://tusitio.com/promociones' });
      return;
    }
    void submit(
      { title: link.title.trim() || url.hostname.replace(/^www\./, ''), kind: link.crawl ? 'website' : 'url', url: url.toString() },
      link.crawl ? 'Sitio agregado: leyendo hasta 20 páginas…' : 'Página agregada: leyendo su contenido…',
      () => setLink({ url: '', title: '', crawl: link.crawl })
    );
  }

  const queued = queue.filter((i) => i.state === 'queued').length;
  const finished = queue.filter((i) => i.state === 'done' || i.invalid).length;

  return (
    <div className="klib-upload">
      <div className="klib-card">
        <div className="klib-section klib-section-tight">
          <div className="klib-segment" role="group" aria-label="Qué quieres agregar">
            <button type="button" aria-pressed={mode === 'files'} onClick={() => setMode('files')}>
              <FileUp size={14} aria-hidden="true" /> Archivos
            </button>
            <button type="button" aria-pressed={mode === 'link'} onClick={() => setMode('link')}>
              <Globe size={14} aria-hidden="true" /> Enlace o sitio web
            </button>
            <button type="button" aria-pressed={mode === 'text'} onClick={() => setMode('text')}>
              <Type size={14} aria-hidden="true" /> Texto
            </button>
          </div>
        </div>

        {message && (
          <div className={`klib-note klib-note-${message.tone} klib-note-flat`} role={message.tone === 'danger' ? 'alert' : 'status'}>
            {message.tone === 'danger' ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            <div className="klib-note-body">{message.text}</div>
          </div>
        )}

        {mode === 'files' && (
          <div className="klib-section">
            <label
              className="klib-drop"
              data-over={dragOver}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
              }}
            >
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={ACCEPT_ATTR}
                className="klib-visually-hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <span className="klib-drop-icon" aria-hidden="true">
                <UploadCloud size={22} />
              </span>
              <strong>Arrastra tus archivos aquí o haz clic para elegirlos</strong>
              <span>Varios a la vez · hasta 40 MB cada uno</span>
              <span className="klib-formats">
                {FORMAT_LABELS.map((f) => (
                  <span key={f} className="klib-format">
                    {f}
                  </span>
                ))}
              </span>
            </label>

            {queue.length > 0 && (
              <>
                <ul className="klib-queue">
                  {queue.map((item) => (
                    <li key={item.key} className="klib-queue-item" data-state={item.state}>
                      <KindIcon kind={fileKindOf(mimeForFile(item.file), item.file.name)} />
                      <div className="klib-queue-main">
                        {item.state === 'queued' ? (
                          <input
                            className="klib-queue-title"
                            value={item.title}
                            onChange={(e) => patch(item.key, { title: e.target.value })}
                            aria-label={`Nombre para ${item.file.name}`}
                          />
                        ) : (
                          <span className="klib-title">{item.title}</span>
                        )}
                        <span className="klib-queue-meta">
                          {item.file.name} · {formatBytes(item.file.size)}
                          {item.state === 'uploading' && ` · subiendo ${item.percent}%`}
                          {item.state === 'saving' && ' · registrando'}
                          {item.state === 'done' && ' · subido, procesando'}
                        </span>
                        {(item.state === 'uploading' || item.state === 'saving') && (
                          <div className="klib-progress" data-state={item.state} aria-hidden="true">
                            <span style={{ width: `${item.percent}%` }} />
                          </div>
                        )}
                        {item.error && <span className="klib-sub klib-sub-danger">{item.error}</span>}
                      </div>
                      <div className="klib-queue-actions">
                        {item.state === 'done' && item.sourceId && (
                          <Button type="button" size="sm" variant="ghost" onClick={() => onOpen(item.sourceId!)}>
                            Ver
                          </Button>
                        )}
                        {item.state === 'error' && !item.invalid && (
                          <Button type="button" size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={() => patch(item.key, { state: 'queued', error: null })}>
                            Reintentar
                          </Button>
                        )}
                        {(item.state === 'uploading' || item.state === 'saving') && <Loader2 size={16} className="klib-spin" aria-label="Subiendo" />}
                        {item.state === 'done' && <CheckCircle2 size={16} className="klib-ok" aria-label="Listo" />}
                        {(item.state === 'queued' || item.state === 'error' || item.state === 'done') && (
                          <button type="button" className="icon-btn" aria-label={`Quitar ${item.file.name}`} onClick={() => setQueue((q) => q.filter((i) => i.key !== item.key))}>
                            <X size={16} />
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="klib-queue-foot">
                  <span className="klib-foot">
                    {queued > 0 ? `${queued} listo${queued === 1 ? '' : 's'} para subir` : running ? 'Subiendo…' : 'Nada pendiente'}
                  </span>
                  <div className="klib-actions-row">
                    {finished > 0 && !running && (
                      <Button type="button" variant="ghost" onClick={() => setQueue((q) => q.filter((i) => i.state !== 'done' && !i.invalid))}>
                        Limpiar terminados
                      </Button>
                    )}
                    <Button type="button" icon={<UploadCloud size={16} />} isLoading={running} disabled={queued === 0} onClick={() => void uploadAll()}>
                      {queued > 1 ? `Subir ${queued} archivos` : 'Subir'}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {mode === 'link' && (
          <div className="klib-section">
            <div className="klib-form">
              <label className="klib-field klib-span">
                <span className="klib-label">Enlace</span>
                <input className="klib-input" type="url" inputMode="url" placeholder="https://tusitio.com/promociones" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} />
              </label>
              <label className="klib-field klib-span">
                <span className="klib-label">Nombre (opcional)</span>
                <input className="klib-input" placeholder="Se usa el dominio si lo dejas vacío" value={link.title} onChange={(e) => setLink({ ...link, title: e.target.value })} />
              </label>
              <div className="klib-field klib-span">
                <span className="klib-label">¿Qué leer?</span>
                <div className="klib-choices" role="group" aria-label="Alcance">
                  <button type="button" className="klib-choice" aria-pressed={!link.crawl} onClick={() => setLink({ ...link, crawl: false })}>
                    <Link2 size={18} aria-hidden="true" />
                    <span>
                      <strong>Solo esta página</strong>
                      <span>Ideal para una promoción, ficha o política publicada.</span>
                    </span>
                  </button>
                  <button type="button" className="klib-choice" aria-pressed={link.crawl} onClick={() => setLink({ ...link, crawl: true })}>
                    <Globe size={18} aria-hidden="true" />
                    <span>
                      <strong>Sitio web completo</strong>
                      <span>Recorre hasta 20 páginas del mismo dominio.</span>
                    </span>
                  </button>
                </div>
              </div>
            </div>
            <p className="klib-foot">Se lee el texto público. Las páginas que solo muestran contenido con JavaScript pueden quedar vacías; en ese caso sube un PDF.</p>
            <div className="klib-actions-row">
              <Button type="button" icon={<Globe size={16} />} isLoading={busy} disabled={link.url.trim().length < 8} onClick={addLink}>
                Agregar {link.crawl ? 'sitio' : 'página'}
              </Button>
            </div>
          </div>
        )}

        {mode === 'text' && (
          <div className="klib-section">
            <div className="klib-form">
              <label className="klib-field klib-span">
                <span className="klib-label">Nombre</span>
                <input className="klib-input" placeholder="Ej. Política de garantías 2026" value={text.title} onChange={(e) => setText({ ...text, title: e.target.value })} />
              </label>
              <label className="klib-field klib-span">
                <span className="klib-label">Contenido</span>
                <textarea className="klib-textarea" rows={12} placeholder="Pega o escribe el texto. Usa títulos en líneas propias para separar secciones." value={text.body} onChange={(e) => setText({ ...text, body: e.target.value })} />
              </label>
            </div>
            <div className="klib-actions-row">
              <Button
                type="button"
                icon={<Type size={16} />}
                isLoading={busy}
                disabled={text.title.trim().length < 2 || text.body.trim().length < 10}
                onClick={() => void submit({ title: text.title.trim(), kind: 'text', text: text.body }, 'Texto agregado: procesando…', () => setText({ title: '', body: '' }))}
              >
                Agregar texto
              </Button>
            </div>
          </div>
        )}
      </div>

      <aside className="klib-card klib-sticky" aria-label="Cómo se guardará">
        <div className="klib-section">
          <h3 className="klib-section-title">Cómo se guardará</h3>
          <p className="klib-section-desc">Aplica a todo lo que agregues desde aquí. Puedes cambiarlo después en cada fuente.</p>
          <div className="klib-stack">
            <div className="klib-field">
              <span className="klib-label">¿Quién puede recibirlo?</span>
              <div className="klib-choices klib-choices-stack" role="group" aria-label="Visibilidad">
                <button type="button" className="klib-choice" aria-pressed={shared.visibility === 'internal'} onClick={() => setShared({ ...shared, visibility: 'internal' })}>
                  <span>
                    <strong>Interna</strong>
                    <span>Para que la IA responda al equipo. Nunca sale a clientes.</span>
                  </span>
                </button>
                <button type="button" className="klib-choice" aria-pressed={shared.visibility === 'publishable'} onClick={() => setShared({ ...shared, visibility: 'publishable' })}>
                  <span>
                    <strong>Publicable</strong>
                    <span>La IA puede enviarlo a clientes cuando se lo pidas.</span>
                  </span>
                </button>
              </div>
            </div>
            <label className="klib-field">
              <span className="klib-label">Categoría</span>
              <select className="klib-select klib-select-full" value={shared.category} onChange={(e) => setShared({ ...shared, category: e.target.value })}>
                <option value="">Sin categoría</option>
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="klib-field">
              <span className="klib-label">Cuándo usarlo</span>
              <textarea
                className="klib-textarea"
                rows={3}
                maxLength={500}
                placeholder="Ej. Cuando un cliente pide las promociones del mes"
                value={shared.useWhen}
                onChange={(e) => setShared({ ...shared, useWhen: e.target.value })}
              />
              <span className="klib-help">Con esto la IA elige el archivo correcto al pedirle “mándale el PDF de…”.</span>
            </label>
            <label className="klib-field">
              <span className="klib-label">Etiquetas</span>
              <input className="klib-input" placeholder="promociones, septiembre" value={shared.tags} onChange={(e) => setShared({ ...shared, tags: e.target.value })} />
            </label>
            <label className="klib-check">
              <input type="checkbox" checked={shared.autoApprove} onChange={(e) => setShared({ ...shared, autoApprove: e.target.checked })} />
              <span>
                <strong>Aprobar en cuanto se procese</strong>
                <span className="klib-help">Si lo dejas apagado, lo revisas y apruebas tú antes de que la IA lo use.</span>
              </span>
            </label>
          </div>
        </div>
      </aside>
    </div>
  );
}
