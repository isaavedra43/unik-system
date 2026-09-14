'use client';

import React, { useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, Search, Share2, UploadCloud } from 'lucide-react';
import { Badge, Button } from '@/components/ui';
import { KindIcon } from './KindIcon';
import {
  CATEGORY_OPTIONS,
  KIND_LABEL,
  STATUS_META,
  STATUS_ORDER,
  categoryLabel,
  currentVersion,
  displayStatus,
  fold,
  formatDate,
  isShareable,
  matchesStatusFilter,
  rowKind,
  sourceSubtitle,
  type RowKind,
  type SourceRow,
} from './knowledge-api';

interface LibraryTableProps {
  sources: SourceRow[];
  mode: 'all' | 'shareable';
  statusFilter: string;
  onStatusFilter: (value: string) => void;
  onOpen: (id: string) => void;
  onUpload: () => void;
}

type SortKey = 'recent' | 'name' | 'status';

export function LibraryTable({ sources, mode, statusFilter, onStatusFilter, onOpen, onUpload }: LibraryTableProps) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [category, setCategory] = useState('');
  const [visibility, setVisibility] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');

  const base = useMemo(() => (mode === 'shareable' ? sources.filter(isShareable) : sources), [sources, mode]);

  const rows = useMemo(() => {
    const terms = fold(query.trim()).split(/\s+/).filter(Boolean);
    const filtered = base.filter((s) => {
      if (!matchesStatusFilter(displayStatus(s), statusFilter)) return false;
      if (kind && rowKind(s) !== kind) return false;
      if (category && (s.category ?? '') !== category) return false;
      if (visibility && s.visibility !== visibility) return false;
      if (terms.length > 0) {
        const haystack = fold(
          [s.title, s.description ?? '', s.tags.join(' '), s.useWhen ?? '', categoryLabel(s.category) ?? '', ...s.versions.map((v) => v.fileName ?? v.sourceUrl ?? '')].join(' ')
        );
        if (!terms.every((t) => haystack.includes(t))) return false;
      }
      return true;
    });
    return filtered.sort((a, b) => {
      if (sort === 'name') return a.title.localeCompare(b.title, 'es');
      if (sort === 'status') return STATUS_ORDER.indexOf(displayStatus(a)) - STATUS_ORDER.indexOf(displayStatus(b));
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [base, query, kind, category, visibility, statusFilter, sort]);

  const filtersActive = Boolean(query || kind || category || visibility || statusFilter);
  const publishableWaiting =
    mode === 'shareable'
      ? sources.filter((s) => s.visibility === 'publishable' && s.status !== 'archived' && !isShareable(s)).length
      : 0;

  function clearFilters() {
    setQuery('');
    setKind('');
    setCategory('');
    setVisibility('');
    onStatusFilter('');
  }

  if (sources.length === 0) {
    return (
      <div className="klib-card">
        <div className="klib-empty">
          <span className="klib-drop-icon" aria-hidden="true">
            <UploadCloud size={22} />
          </span>
          <p className="klib-empty-title">Tu biblioteca está vacía</p>
          <p>Sube catálogos, listas de precios, fichas técnicas, políticas o enlaces de tu sitio. La IA solo responderá con lo que apruebes aquí.</p>
          <Button type="button" icon={<UploadCloud size={16} />} onClick={onUpload}>
            Subir archivos
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="klib-card">
      {mode === 'shareable' && (
        <div className="klib-note klib-note-flat">
          <Share2 size={16} />
          <div className="klib-note-body">
            Estos son los únicos archivos que la IA puede mandar a un cliente cuando se lo pides (&quot;mándale el PDF de promociones&quot;). Siempre envía la versión aprobada.
            {publishableWaiting > 0 ? ` ${publishableWaiting} publicable${publishableWaiting === 1 ? '' : 's'} más aún no se puede${publishableWaiting === 1 ? '' : 'n'} enviar (sin aprobar, vencido o sin archivo).` : ''}
          </div>
        </div>
      )}

      <div className="klib-toolbar">
        <label className="klib-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={mode === 'shareable' ? 'Buscar promociones, catálogos, listas…' : 'Buscar por nombre, etiqueta, archivo o enlace'}
            aria-label="Buscar en la biblioteca"
          />
        </label>
        <select className="klib-select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Tipo">
          <option value="">Todos los tipos</option>
          {(Object.keys(KIND_LABEL) as RowKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <select className="klib-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Categoría">
          <option value="">Todas las categorías</option>
          {CATEGORY_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        {mode === 'all' && (
          <>
            <select className="klib-select" value={visibility} onChange={(e) => setVisibility(e.target.value)} aria-label="Visibilidad">
              <option value="">Interna y publicable</option>
              <option value="internal">Solo internas</option>
              <option value="publishable">Solo publicables</option>
            </select>
            <select className="klib-select" value={statusFilter} onChange={(e) => onStatusFilter(e.target.value)} aria-label="Estado">
              <option value="">Todos los estados</option>
              <option value="attention">Requieren atención</option>
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
                </option>
              ))}
            </select>
          </>
        )}
        <select className="klib-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Ordenar">
          <option value="recent">Más recientes</option>
          <option value="name">Nombre A–Z</option>
          <option value="status">Primero lo pendiente</option>
        </select>
        <span className="klib-count" aria-live="polite">
          {rows.length === base.length ? `${base.length} fuentes` : `${rows.length} de ${base.length}`}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="klib-empty">
          <p className="klib-empty-title">{mode === 'shareable' && base.length === 0 ? 'Aún no hay archivos para compartir' : 'Nada coincide'}</p>
          <p>
            {mode === 'shareable' && base.length === 0
              ? 'Sube un PDF como “Publicable” y apruébalo. Agrega en “Cuándo usarlo” para qué sirve, así la IA elige el archivo correcto.'
              : 'Prueba con otras palabras o quita filtros.'}
          </p>
          {filtersActive ? (
            <Button type="button" variant="secondary" onClick={clearFilters}>
              Quitar filtros
            </Button>
          ) : (
            <Button type="button" icon={<UploadCloud size={16} />} onClick={onUpload}>
              Subir archivos
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="klib-grid klib-list-head" aria-hidden="true">
            <span>Fuente</span>
            <span className="klib-col-cat">Categoría</span>
            <span className="klib-col-extra">{mode === 'shareable' ? 'Cuándo usarlo' : 'Visibilidad'}</span>
            <span>Estado</span>
            <span className="klib-col-date">Actualizada</span>
            <span />
          </div>
          <ul className="klib-list">
            {rows.map((s) => {
              const status = displayStatus(s);
              const latest = s.versions[0];
              return (
                <li key={s.id}>
                  <button type="button" className="klib-item klib-grid" onClick={() => onOpen(s.id)}>
                    <span className="klib-file">
                      <KindIcon kind={rowKind(s)} />
                      <span className="klib-file-text">
                        <span className="klib-title">{s.title}</span>
                        <span className="klib-sub">{sourceSubtitle(s)}</span>
                      </span>
                    </span>
                    <span className="klib-col-cat klib-cell-muted">{categoryLabel(s.category) ?? '—'}</span>
                    <span className="klib-col-extra">
                      {mode === 'shareable' ? (
                        <span className={`klib-cell-muted${s.useWhen ? '' : ' klib-cell-hint'}`}>
                          {s.useWhen || 'Agrega cuándo usarlo'}
                        </span>
                      ) : (
                        <Badge variant={s.visibility === 'publishable' ? 'info' : 'weak'}>
                          {s.visibility === 'publishable' ? 'Publicable' : 'Interna'}
                        </Badge>
                      )}
                    </span>
                    <span className="klib-status-cell">
                      <Badge variant={STATUS_META[status].variant}>{STATUS_META[status].label}</Badge>
                      {status === 'failed' && latest?.error ? (
                        <span className="klib-sub klib-sub-danger" title={latest.error}>
                          <AlertTriangle size={11} aria-hidden="true" /> {latest.error}
                        </span>
                      ) : status === 'approved' && currentVersion(s) ? (
                        <span className="klib-sub">v{currentVersion(s)!.version} · {currentVersion(s)!.chunkCount} fragmentos</span>
                      ) : null}
                    </span>
                    <span className="klib-col-date klib-date">{formatDate(s.updatedAt)}</span>
                    <ChevronRight size={16} className="klib-chevron" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
