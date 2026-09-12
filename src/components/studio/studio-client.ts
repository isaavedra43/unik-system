'use client';

import type {
  StudioBlock,
  StudioContent,
  StudioColumnFormat,
  TableBlock,
} from '@/modules/studio/studio-content';
import type {
  StudioDocumentDetailDTO,
  StudioDocumentSummaryDTO,
  StudioTemplateDTO,
  StudioVersionDTO,
  SaveDocumentResult,
} from '@/modules/studio/studio-service';
import type { StudioExportDTO } from '@/modules/studio/studio-export-service';
import type { StudioExportFormat } from '@/modules/studio/studio-exporters';

/**
 * Browser-side helpers for the studio UI: typed fetch wrappers around
 * /app/studio/api/* and block factories. Types are imported from the server
 * modules with `import type` only (nothing from Node lands in the bundle).
 */

export type {
  StudioBlock,
  StudioContent,
  StudioColumnFormat,
  TableBlock,
  StudioDocumentDetailDTO,
  StudioDocumentSummaryDTO,
  StudioTemplateDTO,
  StudioVersionDTO,
  StudioExportDTO,
  StudioExportFormat,
  SaveDocumentResult,
};

const BASE = '/app/studio/api';

export class StudioApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'StudioApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new StudioApiError('Error de red', 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new StudioApiError(data.error ?? `Error ${res.status}`, res.status, data.code);
  return data as T;
}

export const studioApi = {
  listDocuments: (scope: 'mine' | 'team', includeArchived = false) =>
    request<{ documents: StudioDocumentSummaryDTO[] }>(
      `/documents?scope=${scope}${includeArchived ? '&includeArchived=1' : ''}`
    ).then((r) => r.documents),
  getDocument: (id: string) =>
    request<{ document: StudioDocumentDetailDTO }>(`/documents/${encodeURIComponent(id)}`).then(
      (r) => r.document
    ),
  createDocument: (body: {
    title: string;
    kind: string;
    content?: StudioContent;
    templateId?: string;
  }) =>
    request<{ document: StudioDocumentDetailDTO }>('/documents', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((r) => r.document),
  saveDocument: (
    id: string,
    body: {
      title?: string;
      content?: StudioContent;
      changeSummary?: string;
      storageObjectId?: string | null;
    }
  ) =>
    request<SaveDocumentResult>(`/documents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  archiveDocument: (id: string) =>
    request<{ document: StudioDocumentSummaryDTO }>(`/documents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  listVersions: (id: string) =>
    request<{ versions: StudioVersionDTO[] }>(`/documents/${encodeURIComponent(id)}/versions`).then(
      (r) => r.versions
    ),
  restoreVersion: (id: string, versionId: string) =>
    request<SaveDocumentResult>(
      `/documents/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`,
      {
        method: 'POST',
      }
    ),
  approveDocument: (id: string) =>
    request<{ document: StudioDocumentDetailDTO }>(`/documents/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
    }).then((r) => r.document),
  shareDocument: (id: string) =>
    request<{ document: StudioDocumentDetailDTO }>(`/documents/${encodeURIComponent(id)}/share`, {
      method: 'POST',
    }).then((r) => r.document),
  listExports: (id: string) =>
    request<{ exports: StudioExportDTO[] }>(`/documents/${encodeURIComponent(id)}/exports`).then(
      (r) => r.exports
    ),
  requestExport: (id: string, format: StudioExportFormat) =>
    request<{ export: StudioExportDTO }>(`/documents/${encodeURIComponent(id)}/exports`, {
      method: 'POST',
      body: JSON.stringify({ format }),
    }).then((r) => r.export),
  getExport: (exportId: string) =>
    request<{ export: StudioExportDTO }>(`/exports/${encodeURIComponent(exportId)}`).then(
      (r) => r.export
    ),
  aiEdit: (id: string, body: { blockIds: string[]; instruction: string }) =>
    request<SaveDocumentResult & { blocks: StudioBlock[]; model: string; attempts: number }>(
      `/documents/${encodeURIComponent(id)}/ai-edit`,
      { method: 'POST', body: JSON.stringify(body) }
    ),
  listTemplates: () =>
    request<{ templates: StudioTemplateDTO[] }>('/templates').then((r) => r.templates),
  createTemplate: (body: {
    name: string;
    description?: string;
    kind: string;
    scope: 'personal' | 'team';
    content: StudioContent;
  }) =>
    request<{ template: StudioTemplateDTO }>('/templates', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((r) => r.template),
  deleteTemplate: (id: string) =>
    request<{ ok: true }>(`/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// Block factories (browser-safe ids)
// ---------------------------------------------------------------------------

export function clientBlockId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `b_${random}`;
}

export const BLOCK_TYPE_LABELS: Record<StudioBlock['type'], string> = {
  heading: 'Encabezado',
  paragraph: 'Párrafo',
  list: 'Lista',
  table: 'Tabla',
  kpi: 'Indicadores (KPI)',
  image: 'Imagen',
  pageBreak: 'Salto de página',
  divider: 'Separador',
};

export const COLUMN_FORMAT_LABELS: Record<StudioColumnFormat, string> = {
  text: 'Texto',
  number: 'Número',
  currency: 'Moneda',
  percentage: 'Porcentaje',
  date: 'Fecha',
};

export function newBlock(type: StudioBlock['type']): StudioBlock {
  const id = clientBlockId();
  switch (type) {
    case 'heading':
      return { id, type, level: 2, text: '' };
    case 'paragraph':
      return { id, type, text: '' };
    case 'list':
      return { id, type, items: [''], ordered: false };
    case 'table':
      return {
        id,
        type,
        title: '',
        columns: [
          { key: 'col1', header: 'Concepto' },
          { key: 'col2', header: 'Monto', format: 'currency' },
        ],
        rows: [{ col1: '', col2: null }],
      };
    case 'kpi':
      return { id, type, cards: [{ label: '', value: '' }] };
    case 'image':
      return { id, type, storageObjectId: '', alt: '', caption: '' };
    case 'pageBreak':
      return { id, type };
    case 'divider':
      return { id, type };
  }
}

export function columnKeyFor(table: TableBlock, header: string): string {
  const base =
    header
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'col';
  let key = base;
  let n = 2;
  while (table.columns.some((c) => c.key === key)) key = `${base}_${n++}`;
  return key;
}

export const STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  review: 'En revisión',
  approved: 'Aprobado',
  shared: 'Compartido',
  archived: 'Archivado',
};

export function statusBadgeClass(status: string): string {
  if (status === 'approved' || status === 'shared' || status === 'ready')
    return 'badge badge-success';
  if (status === 'archived' || status === 'failed') return 'badge badge-danger';
  if (status === 'review' || status === 'processing') return 'badge badge-warning';
  return 'badge badge-weak';
}

export function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}
