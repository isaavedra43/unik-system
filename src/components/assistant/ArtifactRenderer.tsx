'use client';

import React, { useEffect, useState } from 'react';
import {
  BarChart3,
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
  Paperclip,
  Table,
  X,
} from 'lucide-react';
import { colorForStatusLabel } from '@/modules/ai/generators/status-tone';

export interface ArtifactData {
  artifactId: string;
  type: 'pdf' | 'xlsx' | 'docx' | 'csv' | 'table' | 'chart' | 'image';
  title: string;
  filename?: string;
  downloadUrl?: string;
  inlineRender?: boolean;
  rowCount?: number;
  sizeBytes?: number;
  pageCount?: number;
  chartType?: string;
  shared?: boolean;
  /** Storage object behind the file (lets a composer attach it without re-uploading). */
  storageObjectId?: string;
  mimeType?: string;
  /** Zoho quote this PDF belongs to (official estimate PDF). */
  quoteId?: string;
  /** Revision number when the file was regenerated with changes (v2, v3…). */
  version?: number;
  /** Id of the newer version that replaced this file. */
  supersededBy?: string;
  createdAt?: string;
}

export interface AttachableArtifact {
  objectId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  artifactId: string;
}

interface InlineTableData {
  title: string;
  subtitle?: string;
  columns: Array<{ header: string; key: string; align?: string; format?: string }>;
  rows: Record<string, unknown>[];
  summary?: Array<{ label: string; value: string }>;
  brandColor?: string;
}

interface InlineChartData {
  svg: string;
  chartType: string;
}

interface InlineImageData {
  svg: string;
  width: number;
  height: number;
}

const TYPE_LABEL: Record<ArtifactData['type'], string> = {
  pdf: 'PDF',
  xlsx: 'Excel',
  docx: 'Word',
  csv: 'CSV',
  table: 'Tabla',
  chart: 'Gráfica',
  image: 'Imagen',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCellValue(value: unknown, format?: string): string {
  if (value === null || value === undefined) return '—';
  if (format === 'currency') return `$${Number(value).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
  if (format === 'number') return Number(value).toLocaleString('es-MX');
  if (format === 'percentage') return `${value}%`;
  if (format === 'date') return String(value);
  return String(value);
}

function ArtifactIcon({ type, size = 20 }: { type: string; size?: number }) {
  switch (type) {
    case 'pdf':
      return <FileText size={size} />;
    case 'xlsx':
      return <FileSpreadsheet size={size} />;
    case 'docx':
      return <FileText size={size} />;
    case 'csv':
      return <File size={size} />;
    case 'chart':
      return <BarChart3 size={size} />;
    case 'image':
      return <ImageIcon size={size} />;
    case 'table':
      return <Table size={size} />;
    default:
      return <File size={size} />;
  }
}

/** In-app requests must stay same-origin (session cookie); absolute APP_URL links are for sharing. */
function localUrl(downloadUrl: string): string {
  return downloadUrl.replace(/^https?:\/\/[^/]+/, '') || downloadUrl;
}

function inlineUrl(downloadUrl: string): string {
  const local = localUrl(downloadUrl);
  return `${local}${local.includes('?') ? '&' : '?'}inline=1`;
}

/** Full-screen preview for PDFs (browser viewer) — no download needed to review. */
function PreviewModal({ artifact, onClose }: { artifact: ArtifactData; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!artifact.downloadUrl) return null;
  return (
    <div className="artifact-preview-backdrop" role="dialog" aria-modal="true" aria-label={`Vista previa de ${artifact.title}`} onClick={onClose}>
      <div className="artifact-preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="artifact-preview-head">
          <span className="artifact-preview-icon"><ArtifactIcon type={artifact.type} size={16} /></span>
          <strong>{artifact.title}</strong>
          <span className="artifact-preview-meta">{TYPE_LABEL[artifact.type]}{artifact.pageCount ? ` · ${artifact.pageCount} págs` : ''}</span>
          <a className="artifact-btn artifact-btn-ghost" href={localUrl(artifact.downloadUrl)} download={artifact.filename}>
            <Download size={14} /> Descargar
          </a>
          <button type="button" className="artifact-iconbtn" onClick={onClose} aria-label="Cerrar">
            <X size={16} />
          </button>
        </div>
        <iframe className="artifact-preview-frame" src={inlineUrl(artifact.downloadUrl)} title={artifact.title} />
      </div>
    </div>
  );
}

export function toAttachable(artifact: ArtifactData): AttachableArtifact | null {
  if (!artifact.storageObjectId) return null;
  const ext = artifact.type === 'xlsx' ? 'xlsx' : artifact.type === 'docx' ? 'docx' : artifact.type === 'csv' ? 'csv' : 'pdf';
  return {
    objectId: artifact.storageObjectId,
    name: artifact.filename ?? `${artifact.title}.${ext}`,
    mimeType: artifact.mimeType ?? (artifact.type === 'pdf' ? 'application/pdf' : 'application/octet-stream'),
    sizeBytes: artifact.sizeBytes ?? 0,
    artifactId: artifact.artifactId,
  };
}

export function ArtifactRenderer({ artifact, compact = false, onAttach }: { artifact: ArtifactData; compact?: boolean; onAttach?: (attachment: AttachableArtifact) => void }) {
  const [inlineData, setInlineData] = useState<InlineTableData | InlineChartData | InlineImageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (artifact.inlineRender) {
      setLoading(true);
      fetch(`/app/assistant/api/artifacts/${artifact.artifactId}`)
        .then((res) => res.json())
        .then((data) => {
          setInlineData(data.artifact?.inlineData ?? null);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [artifact.artifactId, artifact.inlineRender]);

  const copyLink = async () => {
    if (!artifact.downloadUrl) return;
    try {
      const abs = artifact.downloadUrl.startsWith('http') ? artifact.downloadUrl : `${window.location.origin}${artifact.downloadUrl}`;
      await navigator.clipboard.writeText(abs);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore */
    }
  };

  // Inline table
  if (artifact.type === 'table' && inlineData && 'columns' in inlineData) {
    const table = inlineData as InlineTableData;
    return (
      <div className={`artifact-card artifact-table-card ${compact ? 'is-compact' : ''}`}>
        <div className="artifact-table-header" style={{ borderTopColor: table.brandColor ?? 'var(--unik-accent)' }}>
          <div className="artifact-table-title">{table.title}</div>
          {table.subtitle && <div className="artifact-table-subtitle">{table.subtitle}</div>}
        </div>
        <div className="artifact-table-wrapper">
          <table className="artifact-table">
            <thead>
              <tr>
                {table.columns.map((col, i) => (
                  <th key={i} style={{ textAlign: (col.align ?? 'left') as 'left' | 'right' | 'center' }}>
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i} className={i % 2 === 1 ? 'alt' : ''}>
                  {table.columns.map((col, j) => {
                    const text = formatCellValue(row[col.key], col.format);
                    const color = colorForStatusLabel(text);
                    return (
                      <td key={j} style={{ textAlign: (col.align ?? 'left') as 'left' | 'right' | 'center', ...(color ? { color, fontWeight: 600 } : {}) }}>
                        {text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {table.summary && table.summary.length > 0 && (
          <div className="artifact-table-summary">
            {table.summary.map((s, i) => (
              <div key={i} className="artifact-summary-item">
                <span className="artifact-summary-label">{s.label}</span>
                <span className="artifact-summary-value">{s.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Inline chart (SVG)
  if (artifact.type === 'chart' && inlineData && 'svg' in inlineData) {
    const chart = inlineData as InlineChartData;
    return (
      <div className={`artifact-card artifact-chart-card ${compact ? 'is-compact' : ''}`}>
        <div className="artifact-chart-svg" dangerouslySetInnerHTML={{ __html: chart.svg }} />
      </div>
    );
  }

  // Inline report IMAGE (SVG)
  if (artifact.type === 'image' && inlineData && 'svg' in inlineData) {
    const image = inlineData as InlineImageData;
    return (
      <div className={`artifact-card artifact-image-card ${compact ? 'is-compact' : ''}`}>
        <div className="artifact-image-svg" dangerouslySetInnerHTML={{ __html: image.svg }} />
      </div>
    );
  }

  if (artifact.inlineRender && loading) {
    return (
      <div className="artifact-card artifact-loading-card">
        <Loader2 size={18} className="spin" />
        <span>Cargando…</span>
      </div>
    );
  }

  const canPreview = artifact.type === 'pdf' && Boolean(artifact.downloadUrl);
  const attachable = toAttachable(artifact);

  // File card (PDF, XLSX, DOCX, CSV)
  return (
    <>
      <div className={`artifact-card artifact-file-card is-${artifact.type} ${compact ? 'is-compact' : ''}`}>
        <div className="artifact-file-icon">
          <ArtifactIcon type={artifact.type} />
        </div>
        <div className="artifact-file-info">
          <div className="artifact-file-title" title={artifact.title}>{artifact.title}</div>
          <div className="artifact-file-meta">
            <span className="artifact-type-pill">{TYPE_LABEL[artifact.type] ?? artifact.type.toUpperCase()}</span>
            {artifact.rowCount !== undefined && <span>{artifact.rowCount} filas</span>}
            {artifact.pageCount !== undefined && <span>{artifact.pageCount} págs</span>}
            {artifact.sizeBytes !== undefined && <span>{formatBytes(artifact.sizeBytes)}</span>}
            {artifact.shared && <span className="artifact-shared-pill"><Link2 size={11} /> compartido</span>}
            {artifact.version !== undefined && artifact.version > 1 && <span className="artifact-version-pill">v{artifact.version}</span>}
            {artifact.supersededBy && <span className="artifact-superseded-pill">sustituido por una versión nueva</span>}
          </div>
        </div>
        <div className="artifact-file-actions">
          {canPreview && (
            <button type="button" className="artifact-btn artifact-btn-ghost" onClick={() => setPreview(true)} title="Ver antes de enviar">
              <Eye size={14} /> <span>Ver</span>
            </button>
          )}
          {onAttach && attachable ? (
            <button type="button" className="artifact-btn artifact-btn-ghost" onClick={() => onAttach(attachable)} title="Adjuntar al redactor del mensaje">
              <Paperclip size={14} /> <span>Adjuntar</span>
            </button>
          ) : (
            artifact.downloadUrl && (
              <button type="button" className="artifact-btn artifact-btn-ghost" onClick={copyLink} title="Copiar enlace">
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            )
          )}
          {artifact.downloadUrl && (
            <a href={localUrl(artifact.downloadUrl)} className="artifact-btn artifact-btn-primary" download={artifact.filename}>
              <Download size={14} /> <span>Descargar</span>
            </a>
          )}
        </div>
      </div>
      {preview && <PreviewModal artifact={artifact} onClose={() => setPreview(false)} />}
    </>
  );
}
