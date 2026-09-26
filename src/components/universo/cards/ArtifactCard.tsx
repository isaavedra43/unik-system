'use client';

import React, { useEffect, useState } from 'react';
import {
  ChartColumn,
  Check,
  Copy,
  Download,
  Eye,
  File,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Link2,
  Loader2,
  Table2,
  X,
} from 'lucide-react';
import { toneForStatusLabel } from '@/modules/ai/generators/status-tone';
import { cn } from '@/lib/utils';
import type { ArtifactInfo } from '../lib/types';
import { formatBytes } from '../lib/format';

/**
 * Files the agent generated (PDF, Excel, Word, CSV, charts, images, tables):
 * preview in place, full-screen viewer for PDFs, download, copy link.
 */

interface InlineTable {
  title: string;
  subtitle?: string;
  columns: Array<{ header: string; key: string; align?: string; format?: string }>;
  rows: Record<string, unknown>[];
  summary?: Array<{ label: string; value: string }>;
}
interface InlineSvg {
  svg: string;
}

const TYPE_LABEL: Record<ArtifactInfo['type'], string> = {
  pdf: 'PDF',
  xlsx: 'Excel',
  docx: 'Word',
  csv: 'CSV',
  table: 'Tabla',
  chart: 'Gráfica',
  image: 'Imagen',
};

function TypeIcon({ type, size = 18 }: { type: string; size?: number }) {
  switch (type) {
    case 'pdf':
    case 'docx':
      return <FileText size={size} />;
    case 'xlsx':
      return <FileSpreadsheet size={size} />;
    case 'chart':
      return <ChartColumn size={size} />;
    case 'image':
      return <ImageIcon size={size} />;
    case 'table':
      return <Table2 size={size} />;
    default:
      return <File size={size} />;
  }
}

/** In-app requests stay same-origin (session cookie); absolute URLs are for sharing. */
export function localUrl(downloadUrl: string): string {
  return downloadUrl.replace(/^https?:\/\/[^/]+/, '') || downloadUrl;
}

function inlineUrl(downloadUrl: string): string {
  const local = localUrl(downloadUrl);
  return `${local}${local.includes('?') ? '&' : '?'}inline=1`;
}

function formatCell(value: unknown, format?: string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (format === 'currency')
    return `$${Number(value).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
  if (format === 'number') return Number(value).toLocaleString('es-MX');
  if (format === 'percentage') return `${value}%`;
  return String(value);
}

export function FileViewer({
  title,
  src,
  downloadUrl,
  filename,
  onClose,
}: {
  title: string;
  src: string;
  downloadUrl?: string;
  filename?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="uv-viewer uv-scope"
      role="dialog"
      aria-modal="true"
      aria-label={`Vista previa de ${title}`}
    >
      <div className="uv-viewer-bar">
        <strong>{title}</strong>
        {downloadUrl && (
          <a className="uv-btn is-secondary is-sm" href={localUrl(downloadUrl)} download={filename}>
            <Download size={13} /> Descargar
          </a>
        )}
        <button
          type="button"
          className="uv-icon-btn"
          onClick={onClose}
          aria-label="Cerrar vista previa"
        >
          <X size={18} />
        </button>
      </div>
      <iframe src={src} title={title} />
    </div>
  );
}

export function ArtifactCard({ artifact }: { artifact: ArtifactInfo }) {
  const [inline, setInline] = useState<InlineTable | InlineSvg | null>(null);
  const [loading, setLoading] = useState(Boolean(artifact.inlineRender));
  const [viewer, setViewer] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!artifact.inlineRender) return;
    let alive = true;
    setLoading(true);
    fetch(`/app/assistant/api/artifacts/${artifact.artifactId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { artifact?: { inlineData?: InlineTable | InlineSvg } } | null) => {
        if (alive) setInline(d?.artifact?.inlineData ?? null);
      })
      .catch(() => undefined)
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [artifact.artifactId, artifact.inlineRender]);

  const copyLink = async () => {
    if (!artifact.downloadUrl) return;
    const abs = artifact.downloadUrl.startsWith('http')
      ? artifact.downloadUrl
      : `${window.location.origin}${artifact.downloadUrl}`;
    try {
      await navigator.clipboard.writeText(abs);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  };

  const meta = [
    TYPE_LABEL[artifact.type] ?? artifact.type.toUpperCase(),
    artifact.rowCount !== undefined ? `${artifact.rowCount} filas` : null,
    artifact.pageCount !== undefined ? `${artifact.pageCount} págs` : null,
    artifact.sizeBytes !== undefined ? formatBytes(artifact.sizeBytes) : null,
    artifact.version && artifact.version > 1 ? `v${artifact.version}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const head = (
    <div className="uv-artifact">
      <span className={cn('uv-artifact-icon', `is-${artifact.type}`)}>
        <TypeIcon type={artifact.type} />
      </span>
      <div className="uv-artifact-text">
        <div className="uv-artifact-name" title={artifact.title}>
          {artifact.title}
        </div>
        <div className="uv-artifact-meta">
          {meta}
          {artifact.shared && (
            <>
              {' · '}
              <Link2 size={11} style={{ verticalAlign: '-1px' }} /> compartido
            </>
          )}
          {artifact.supersededBy && ' · sustituido por una versión nueva'}
        </div>
      </div>
      <div className="uv-artifact-actions">
        {artifact.type === 'pdf' && artifact.downloadUrl && (
          <button
            type="button"
            className="uv-icon-btn"
            onClick={() => setViewer(true)}
            aria-label="Ver PDF"
            title="Ver"
          >
            <Eye size={16} />
          </button>
        )}
        {artifact.downloadUrl && (
          <button
            type="button"
            className="uv-icon-btn"
            onClick={copyLink}
            aria-label="Copiar enlace"
            title="Copiar enlace"
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        )}
        {artifact.downloadUrl && (
          <a
            className="uv-btn is-secondary is-sm"
            href={localUrl(artifact.downloadUrl)}
            download={artifact.filename}
          >
            <Download size={13} /> Descargar
          </a>
        )}
      </div>
    </div>
  );

  let preview: React.ReactNode = null;
  if (loading) {
    preview = (
      <div
        className="uv-artifact-preview"
        style={{ padding: 16, display: 'flex', gap: 8, alignItems: 'center' }}
      >
        <Loader2 size={15} className="uv-spin" />{' '}
        <span style={{ fontSize: 12.5 }}>Cargando vista previa…</span>
      </div>
    );
  } else if (inline && 'columns' in inline) {
    preview = (
      <div className="uv-artifact-preview">
        <div className="uv-dt-wrap" style={{ borderTop: 0 }}>
          <table className="uv-dt">
            <thead>
              <tr>
                {inline.columns.map((c, i) => (
                  <th key={i} className={c.align === 'right' ? 'is-num' : undefined}>
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {inline.rows.slice(0, 50).map((row, ri) => (
                <tr key={ri}>
                  {inline.columns.map((c, ci) => {
                    const text = formatCell(row[c.key], c.format);
                    const tone = toneForStatusLabel(text);
                    return (
                      <td key={ci} className={c.align === 'right' ? 'is-num' : undefined}>
                        {tone ? (
                          <span
                            className={cn(
                              'uv-pill',
                              tone === 'success'
                                ? 'is-live'
                                : tone === 'warning'
                                  ? 'is-warn'
                                  : tone === 'danger'
                                    ? 'is-danger'
                                    : tone === 'info'
                                      ? 'is-info'
                                      : ''
                            )}
                          >
                            {text}
                          </span>
                        ) : (
                          text
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {inline.summary && inline.summary.length > 0 && (
          <div className="uv-kpis" style={{ borderTop: '1px solid var(--uv-line)' }}>
            {inline.summary.map((s, i) => (
              <div key={i} className="uv-kpi">
                <span className="uv-kpi-label">{s.label}</span>
                <span className="uv-kpi-value" style={{ fontSize: '1.05rem' }}>
                  {s.value}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  } else if (inline && 'svg' in inline) {
    // Server-generated SVG (report/chart generators sanitize every color/text).
    preview = (
      <div className="uv-artifact-preview">
        <div className="uv-svg-wrap" dangerouslySetInnerHTML={{ __html: inline.svg }} />
      </div>
    );
  }

  return (
    <section className="uv-card" aria-label={artifact.title}>
      {head}
      {preview}
      {viewer && artifact.downloadUrl && (
        <FileViewer
          title={artifact.title}
          src={inlineUrl(artifact.downloadUrl)}
          downloadUrl={artifact.downloadUrl}
          filename={artifact.filename}
          onClose={() => setViewer(false)}
        />
      )}
    </section>
  );
}
