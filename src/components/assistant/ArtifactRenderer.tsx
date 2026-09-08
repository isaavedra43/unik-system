'use client';

import React, { useEffect, useState } from 'react';
import { FileText, FileSpreadsheet, File, BarChart3, Table, Download, Loader2 } from 'lucide-react';

export interface ArtifactData {
  artifactId: string;
  type: 'pdf' | 'xlsx' | 'csv' | 'table' | 'chart' | 'image';
  title: string;
  filename?: string;
  downloadUrl?: string;
  inlineRender?: boolean;
  rowCount?: number;
  sizeBytes?: number;
  pageCount?: number;
  chartType?: string;
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

function ArtifactIcon({ type }: { type: string }) {
  switch (type) {
    case 'pdf':
      return <FileText size={20} />;
    case 'xlsx':
      return <FileSpreadsheet size={20} />;
    case 'csv':
      return <File size={20} />;
    case 'chart':
      return <BarChart3 size={20} />;
    case 'table':
      return <Table size={20} />;
    default:
      return <File size={20} />;
  }
}

export function ArtifactRenderer({ artifact }: { artifact: ArtifactData }) {
  const [inlineData, setInlineData] = useState<InlineTableData | InlineChartData | null>(null);
  const [loading, setLoading] = useState(false);

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

  // Inline table
  if (artifact.type === 'table' && inlineData && 'columns' in inlineData) {
    const table = inlineData as InlineTableData;
    return (
      <div className="artifact-card artifact-table-card">
        <div className="artifact-table-header" style={{ borderTopColor: table.brandColor ?? '#2563eb' }}>
          <div className="artifact-table-title">{table.title}</div>
          {table.subtitle && <div className="artifact-table-subtitle">{table.subtitle}</div>}
        </div>
        <div className="artifact-table-wrapper">
          <table className="artifact-table">
            <thead>
              <tr>
                {table.columns.map((col, i) => (
                  <th
                    key={i}
                    style={{ textAlign: (col.align ?? 'left') as 'left' | 'right' | 'center' }}
                  >
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i} className={i % 2 === 1 ? 'alt' : ''}>
                  {table.columns.map((col, j) => (
                    <td
                      key={j}
                      style={{ textAlign: (col.align ?? 'left') as 'left' | 'right' | 'center' }}
                    >
                      {formatCellValue(row[col.key], col.format)}
                    </td>
                  ))}
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
      <div className="artifact-card artifact-chart-card">
        <div
          className="artifact-chart-svg"
          dangerouslySetInnerHTML={{ __html: chart.svg }}
        />
      </div>
    );
  }

  // Loading inline
  if (artifact.inlineRender && loading) {
    return (
      <div className="artifact-card artifact-loading-card">
        <Loader2 size={20} className="spin" />
        <span>Cargando artefacto…</span>
      </div>
    );
  }

  // File download card (PDF, XLSX, CSV)
  return (
    <div className="artifact-card artifact-file-card">
      <div className="artifact-file-icon">
        <ArtifactIcon type={artifact.type} />
      </div>
      <div className="artifact-file-info">
        <div className="artifact-file-title">{artifact.title}</div>
        <div className="artifact-file-meta">
          {artifact.type.toUpperCase()}
          {artifact.rowCount !== undefined && ` · ${artifact.rowCount} filas`}
          {artifact.pageCount !== undefined && ` · ${artifact.pageCount} págs`}
          {artifact.sizeBytes !== undefined && ` · ${formatBytes(artifact.sizeBytes)}`}
        </div>
      </div>
      {artifact.downloadUrl && (
        <a
          href={artifact.downloadUrl}
          className="artifact-download-btn"
          download={artifact.filename}
        >
          <Download size={16} />
          Descargar
        </a>
      )}
    </div>
  );
}
