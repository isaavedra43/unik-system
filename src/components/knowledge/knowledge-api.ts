import type { BadgeVariant } from '@/components/ui';
import {
  KNOWLEDGE_CATEGORY_LABELS,
  KNOWLEDGE_CATEGORY_VALUES,
  fileKindOf,
  type KnowledgeFileKind,
  type SheetPreview,
} from '@/modules/copilot/knowledge-extract';

/* Types mirrored from /app/admin/knowledge/api (knowledge-service DTOs). */

export type VersionStatus = 'processing' | 'ready' | 'failed';

export interface VersionRow {
  id: string;
  version: number;
  status: VersionStatus;
  chunkCount: number;
  error: string | null;
  storageObjectId: string | null;
  sourceUrl: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  pageCount: number;
  autoApprove: boolean;
  createdAt: string;
}

export interface SourceRow {
  id: string;
  title: string;
  description: string | null;
  kind: 'document' | 'url' | 'website' | 'text';
  visibility: 'internal' | 'publishable';
  status: 'draft' | 'approved' | 'archived';
  currentVersionId: string | null;
  tags: string[];
  category: string | null;
  useWhen: string | null;
  expiresAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  versions: VersionRow[];
}

export interface Chunk {
  ordinal: number;
  section: string | null;
  content: string;
}

export interface SourceDetail {
  versionId: string | null;
  chunks: Chunk[];
  totalChunks: number;
}

export type Preview =
  | { type: 'pdf'; url: string; fileName: string }
  | { type: 'html'; html: string; fileName: string }
  | { type: 'table'; sheets: SheetPreview[]; fileName: string }
  | { type: 'text'; text: string; truncated: boolean; fileName: string | null }
  | { type: 'web'; url: string; pageCount: number; text: string; truncated: boolean }
  | { type: 'none'; message: string };

export interface Hit {
  sourceId: string;
  title: string;
  visibility: string;
  version: number;
  section: string | null;
  excerpt: string;
  rank: number;
  match?: 'lexical' | 'semantic' | 'hybrid';
}

export interface ShareableResult {
  request: string;
  decision: 'single' | 'ambiguous' | 'none';
  totalShareable: number;
  matches: Array<{
    knowledgeSourceId: string;
    title: string;
    category: string | null;
    useWhen: string | null;
    fileName: string;
    version: number;
    score: number;
  }>;
  instruction: string;
}

export interface ConnectionRow {
  id: string;
  name: string;
  namespace: string;
  kind: string;
  status: string;
  description: string | null;
  capabilities: number;
  accounts: number;
  executions: number;
  updatedAt: string;
}

/* Fetch */

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Error ${res.status}`);
  return data as T;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Ocurrió un error inesperado';
}

/* Labels */

export const CATEGORY_OPTIONS = KNOWLEDGE_CATEGORY_VALUES.map((value) => ({
  value,
  label: KNOWLEDGE_CATEGORY_LABELS[value],
}));

export function categoryLabel(value: string | null): string | null {
  if (!value) return null;
  return (KNOWLEDGE_CATEGORY_LABELS as Record<string, string>)[value] ?? value;
}

export type RowKind = KnowledgeFileKind | 'link' | 'site';

export const KIND_LABEL: Record<RowKind, string> = {
  pdf: 'PDF',
  word: 'Word',
  excel: 'Excel',
  csv: 'CSV',
  text: 'Texto',
  web: 'HTML',
  link: 'Página web',
  site: 'Sitio web',
};

export type DisplayStatus = 'empty' | 'processing' | 'failed' | 'review' | 'update' | 'approved' | 'expired' | 'archived';

export const STATUS_META: Record<DisplayStatus, { label: string; variant: BadgeVariant }> = {
  failed: { label: 'Falló', variant: 'danger' },
  expired: { label: 'Vencida', variant: 'danger' },
  update: { label: 'Nueva versión', variant: 'warning' },
  review: { label: 'Por aprobar', variant: 'warning' },
  processing: { label: 'Procesando', variant: 'info' },
  empty: { label: 'Sin contenido', variant: 'weak' },
  approved: { label: 'Aprobada', variant: 'success' },
  archived: { label: 'Archivada', variant: 'weak' },
};

export const STATUS_ORDER = Object.keys(STATUS_META) as DisplayStatus[];
export const ATTENTION_STATUSES: DisplayStatus[] = ['review', 'update', 'failed', 'expired'];

/* Derived state */

export function currentVersion(s: SourceRow): VersionRow | null {
  return s.versions.find((v) => v.id === s.currentVersionId) ?? null;
}

export function isExpired(s: SourceRow, now = Date.now()): boolean {
  return Boolean(s.expiresAt && new Date(s.expiresAt).getTime() <= now);
}

export function displayStatus(s: SourceRow): DisplayStatus {
  if (s.status === 'archived') return 'archived';
  const latest = s.versions[0];
  if (latest?.status === 'processing') return 'processing';
  if (s.status === 'approved' && s.currentVersionId) {
    if (isExpired(s)) return 'expired';
    if (latest && latest.status === 'ready' && latest.id !== s.currentVersionId) return 'update';
    return 'approved';
  }
  if (!latest) return 'empty';
  if (latest.status === 'failed') return 'failed';
  return 'review';
}

export function matchesStatusFilter(status: DisplayStatus, filter: string): boolean {
  if (!filter) return true;
  if (filter === 'attention') return ATTENTION_STATUSES.includes(status);
  if (filter === 'approved') return status === 'approved' || status === 'update';
  return status === filter;
}

/** What the assistant can send to a customer right now. */
export function isShareable(s: SourceRow): boolean {
  const st = displayStatus(s);
  return (st === 'approved' || st === 'update') && s.visibility === 'publishable' && Boolean(currentVersion(s)?.storageObjectId);
}

export function rowKind(s: SourceRow): RowKind {
  const v = currentVersion(s) ?? s.versions[0];
  if (s.kind === 'website') return 'site';
  if (s.kind === 'url' || v?.sourceUrl) return 'link';
  return fileKindOf(v?.mimeType, v?.fileName);
}

export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Second line under a source title: file name / site and size. */
export function sourceSubtitle(s: SourceRow): string {
  const v = currentVersion(s) ?? s.versions[0];
  const kind = KIND_LABEL[rowKind(s)];
  if (!v) return `${kind} · sin contenido`;
  if (v.sourceUrl) {
    const pages = s.kind === 'website' && v.pageCount > 0 ? ` · ${v.pageCount} páginas` : '';
    return `${kind} · ${hostOf(v.sourceUrl)}${pages}`;
  }
  return [kind, v.fileName, formatBytes(v.sizeBytes)].filter(Boolean).join(' · ');
}

/* Uploads */

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
};

export const FORMAT_LABELS = ['PDF', 'Word', 'Excel', 'CSV', 'TXT', 'Markdown', 'HTML', 'JSON'];
export const ACCEPT_ATTR = Object.keys(EXT_MIME).map((e) => `.${e}`).join(',');
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

/** Mime by extension (browsers often declare CSV as Excel or leave it empty). Null = not allowed. */
export function mimeForFile(file: File): string | null {
  return EXT_MIME[extensionOf(file.name)] ?? null;
}

export function validateFile(file: File): string | null {
  if (!mimeForFile(file)) return `Formato .${extensionOf(file.name) || '?'} no permitido`;
  if (file.size === 0) return 'El archivo está vacío';
  if (file.size > MAX_UPLOAD_BYTES) return `Pesa ${formatBytes(file.size)}; el máximo es 40 MB`;
  return null;
}

export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Documento';
}

export function splitTags(value: string): string[] {
  return [...new Set(value.split(',').map((t) => t.trim()).filter(Boolean))].slice(0, 20);
}
