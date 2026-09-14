import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { hasPermission } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { enqueueJob, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import {
  deleteObjectIfUnreferenced,
  getStorageObject,
  readObjectToBuffer,
  saveGeneratedFile,
  StorageError,
  type UploadPolicy,
} from '@/modules/storage/storage-service';
import {
  registerFileAccessResolver,
  registerUploadTargetResolver,
} from '@/modules/storage/storage-access';
import { safeFetch } from '@/modules/extensions/safe-fetch';
import { buildTsQuery, chunkText, normalizeText } from './knowledge-chunker';
import {
  KNOWLEDGE_CATEGORY_VALUES,
  KNOWLEDGE_MIME,
  extractHtmlTitle,
  extractSameSiteLinks,
  fileKindOf,
  htmlToText,
  parseCsv,
  rankShareable,
  sheetPreview,
  sheetsToText,
  type ShareableDecision,
  type SheetData,
  type SheetPreview,
} from './knowledge-extract';
import { embedQuery, embedVersionChunks } from '@/modules/ai/embeddings-service';
import { cosineSimilarity, reciprocalRankFusion } from '@/modules/ai/rag-fusion';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';

/**
 * Approved knowledge library.
 *
 * Sources (documents, spreadsheets, web pages, whole websites, texts) have versions; a version is
 * processed (text extraction + chunking) by a background job and becomes searchable ONLY after an
 * administrator approves it (or it was uploaded with auto-approve by that administrator).
 * `visibility` separates internal information from publishable content: only approved,
 * publishable, non-expired sources are sent to customers, and always in their APPROVED version.
 * A document a customer sent in a chat never enters the library by itself.
 */

export const KNOWLEDGE_PROCESS_JOB = 'knowledge.process_version';
const MAX_TEXT_BYTES = 40 * 1024 * 1024;
const MAX_URL_BYTES = 5 * 1024 * 1024;
const WEBSITE_MAX_PAGES = 20;
const MAX_SHEET_ROWS = 50_000;
const PREVIEW_TABLE_ROWS = 200;
const PREVIEW_TEXT_CHARS = 200_000;
const MAX_DETAIL_CHUNKS = 400;

export class KnowledgeError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

const dateInput = z
  .union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)])
  .nullable()
  .optional();

export const createSourceSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().max(2000).optional(),
  kind: z.enum(['document', 'url', 'website', 'text']),
  visibility: z.enum(['internal', 'publishable']).default('internal'),
  tags: z.array(z.string().trim().max(40)).max(20).default([]),
  category: z.enum(KNOWLEDGE_CATEGORY_VALUES).nullable().optional(),
  useWhen: z.string().max(500).nullable().optional(),
  expiresAt: dateInput,
});

const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), { message: 'Solo enlaces http o https' });

export const createVersionSchema = z
  .object({
    storageObjectId: z.string().optional(),
    text: z.string().max(2_000_000).optional(),
    url: httpUrl.optional(),
    allowedHosts: z.array(z.string().max(253)).max(5).optional(),
    autoApprove: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.storageObjectId || v.text || v.url), {
    message: 'Indica un archivo, un texto o una URL',
  });

/** One-step creation from the upload screen: metadata plus (optionally) its first version. */
export const createSourceWithContentSchema = createSourceSchema.extend({
  storageObjectId: z.string().optional(),
  text: z.string().max(2_000_000).optional(),
  url: httpUrl.optional(),
  autoApprove: z.boolean().optional(),
});

export const updateSourceSchema = createSourceSchema
  .omit({ kind: true })
  .partial()
  .extend({ status: z.enum(['draft', 'approved', 'archived']).optional() });

function knowledgeUploadPolicy(): UploadPolicy {
  return {
    purpose: 'knowledge',
    maxBytes: MAX_TEXT_BYTES,
    allowedMimeTypes: Object.values(KNOWLEDGE_MIME),
    retentionPolicy: 'protected',
  };
}

// New version of an existing source.
registerUploadTargetResolver('knowledge_source', async (actor, sourceId) => {
  if (!hasPermission(actor, 'knowledge.manage'))
    throw new StorageError('Sin permiso', 'forbidden', 403);
  const source = await prisma.knowledgeSource.findUnique({
    where: { id: sourceId },
    select: { id: true },
  });
  if (!source) throw new StorageError('Fuente no encontrada', 'not_found', 404);
  return { policy: knowledgeUploadPolicy() };
});

// File for a source that is created right after the upload (bulk upload screen).
registerUploadTargetResolver('knowledge_library', async (actor) => {
  if (!hasPermission(actor, 'knowledge.manage'))
    throw new StorageError('Sin permiso', 'forbidden', 403);
  return { policy: knowledgeUploadPolicy() };
});

registerFileAccessResolver('knowledge', async (actor, object) => {
  if (hasPermission(actor, 'knowledge.manage')) return true;
  if (!hasPermission(actor, 'assistant.use')) return false;
  const version = await prisma.knowledgeSourceVersion.findFirst({
    where: { storageObjectId: object.id },
    select: {
      status: true,
      source: { select: { status: true, currentVersionId: true } },
      id: true,
    },
  });
  return Boolean(
    version &&
    version.status === 'ready' &&
    version.source.status === 'approved' &&
    version.source.currentVersionId === version.id
  );
});

function toDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59` : value);
}

function normalizeTags(tags: string[] | undefined): string[] | undefined {
  if (!tags) return undefined;
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
}

function emptyToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value?.trim() ? value.trim() : null;
}

export async function createSource(actor: CurrentUser, input: z.infer<typeof createSourceSchema>) {
  const source = await prisma.knowledgeSource.create({
    data: {
      title: input.title,
      description: emptyToNull(input.description) ?? null,
      kind: input.kind,
      visibility: input.visibility,
      tags: normalizeTags(input.tags) ?? [],
      category: input.category ?? null,
      useWhen: emptyToNull(input.useWhen) ?? null,
      expiresAt: toDate(input.expiresAt) ?? null,
      createdBy: actor.id,
    },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'knowledge.source_created',
    targetType: 'knowledge_source',
    targetId: source.id,
  });
  return source;
}

/** Creates the source and, when content is given, its first version in the same request. */
export async function createSourceWithContent(
  actor: CurrentUser,
  input: z.infer<typeof createSourceWithContentSchema>
) {
  const { storageObjectId, text, url, autoApprove, ...meta } = input;
  const source = await createSource(actor, meta);
  if (!storageObjectId && !text && !url) return { source, version: null };
  try {
    const version = await createVersion(actor, source.id, { storageObjectId, text, url, autoApprove });
    return { source, version };
  } catch (err) {
    // Never leave an empty draft behind a failed upload.
    await prisma.knowledgeSource.delete({ where: { id: source.id } }).catch(() => undefined);
    throw err;
  }
}

export async function updateSource(
  actor: CurrentUser,
  id: string,
  patch: z.infer<typeof updateSourceSchema>
) {
  const source = await prisma.knowledgeSource.findUnique({ where: { id } });
  if (!source) throw new KnowledgeError('Fuente no encontrada', 404);
  if (patch.status === 'approved' && !source.currentVersionId) {
    throw new KnowledgeError('Aprueba una versión antes de restaurar la fuente como aprobada', 409);
  }
  const updated = await prisma.knowledgeSource.update({
    where: { id },
    data: {
      title: patch.title,
      description: emptyToNull(patch.description),
      visibility: patch.visibility,
      tags: normalizeTags(patch.tags),
      category: patch.category,
      useWhen: emptyToNull(patch.useWhen),
      expiresAt: toDate(patch.expiresAt),
      status: patch.status,
    },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'knowledge.source_updated',
    targetType: 'knowledge_source',
    targetId: id,
    metadata: { changedKeys: Object.keys(patch) },
  });
  return updated;
}

/** Creates a version from an uploaded object, raw text or a URL and enqueues processing. */
export async function createVersion(
  actor: CurrentUser,
  sourceId: string,
  input: z.infer<typeof createVersionSchema>
) {
  const source = await prisma.knowledgeSource.findUnique({
    where: { id: sourceId },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  if (!source) throw new KnowledgeError('Fuente no encontrada', 404);
  let storageObjectId = input.storageObjectId ?? null;
  let fileMeta: { fileName: string | null; mimeType: string | null; sizeBytes: number | null } = {
    fileName: null,
    mimeType: null,
    sizeBytes: null,
  };
  if (storageObjectId) {
    const object = await getStorageObject(storageObjectId);
    if (!object || object.status !== 'ready' || object.purpose !== 'knowledge') {
      throw new KnowledgeError('El archivo no está listo o no pertenece a la biblioteca', 409);
    }
    fileMeta = {
      fileName: object.originalName,
      mimeType: object.detectedMimeType ?? object.declaredMimeType,
      sizeBytes: Number(object.sizeBytes),
    };
  } else if (input.text) {
    const buffer = Buffer.from(input.text, 'utf8');
    const fileName = `${source.title.replace(/[^A-Za-z0-9]+/g, '_')}.txt`;
    const object = await saveGeneratedFile({
      createdBy: actor.id,
      purpose: 'knowledge',
      fileName,
      mimeType: 'text/plain',
      source: { buffer },
      retentionPolicy: 'protected',
    });
    storageObjectId = object.id;
    fileMeta = { fileName, mimeType: 'text/plain', sizeBytes: buffer.byteLength };
  }
  const version = await prisma.knowledgeSourceVersion.create({
    data: {
      sourceId,
      version: (source.versions[0]?.version ?? 0) + 1,
      storageObjectId,
      sourceUrl: input.url ?? null,
      status: 'processing',
      autoApprove: input.autoApprove ?? false,
      ...fileMeta,
      createdBy: actor.id,
    },
  });
  await enqueueJob({
    type: KNOWLEDGE_PROCESS_JOB,
    payload: { versionId: version.id, allowedHosts: input.allowedHosts ?? [] },
    priority: JOB_PRIORITY.interactive,
    dedupeKey: `${KNOWLEDGE_PROCESS_JOB}:${version.id}`,
    createdBy: actor.id,
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'knowledge.version_created',
    targetType: 'knowledge_version',
    targetId: version.id,
    metadata: { sourceId, kind: source.kind, autoApprove: version.autoApprove },
  });
  return version;
}

/* ------------------------------------------------------------------ */
/* Extraction                                                         */
/* ------------------------------------------------------------------ */

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const o = value as { text?: unknown; result?: unknown; richText?: Array<{ text: string }> };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join('');
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return cellText(o.result);
    return '';
  }
  return String(value);
}

async function readWorkbook(buffer: Buffer, maxRows = MAX_SHEET_ROWS): Promise<SheetData[]> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheets: SheetData[] = [];
  let budget = maxRows;
  workbook.eachSheet((sheet) => {
    if (budget <= 0 || (sheet.state && sheet.state !== 'visible')) return;
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (budget <= 0) return;
      rows.push(Array.from((row.values as unknown[]).slice(1), (v) => cellText(v)));
      budget -= 1;
    });
    sheets.push({ name: sheet.name, rows });
  });
  return sheets;
}

async function extractPdf(buffer: Buffer): Promise<string> {
  let text = '';
  try {
    const pdfParseModule = await import('pdf-parse/lib/pdf-parse.js');
    const pdfParse = pdfParseModule.default || pdfParseModule;
    text = ((await pdfParse(buffer)).text ?? '').trim();
  } catch {
    text = '';
  }
  if (text.length === 0) {
    const { extractText: unpdfExtract, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    text = ((await unpdfExtract(pdf, { mergePages: true })).text ?? '').trim();
  }
  return normalizeText(text);
}

async function docxToHtml(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.convertToHtml({ buffer });
  return value.replace(/<img\b[^>]*>/gi, '');
}

async function fetchPage(url: string, hosts: string[]): Promise<string> {
  const res = await safeFetch(
    url,
    {
      method: 'GET',
      headers: { 'User-Agent': 'UNIK-Biblioteca/1.0', Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' },
    },
    {
      allowedHosts: hosts,
      maxResponseBytes: MAX_URL_BYTES,
      timeoutMs: 20_000,
      allowedContentTypes: ['text/', 'application/json', 'application/xml', 'application/xhtml+xml'],
    }
  );
  if (res.status >= 400) throw new KnowledgeError(`La página respondió ${res.status}`, 422);
  return res.body.toString('utf8');
}

/** Reads one page, or up to WEBSITE_MAX_PAGES pages of the same host (breadth-first). */
async function crawlPages(startUrl: string, hosts: string[], maxPages: number) {
  const queue = [startUrl];
  const seen = new Set<string>();
  const pages: Array<{ url: string; title: string; text: string }> = [];
  let startError: unknown = null;
  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const html = await fetchPage(url, hosts);
      const isHtml = /<[a-z][\s\S]*>/i.test(html);
      const text = isHtml ? htmlToText(html) : normalizeText(html);
      if (text.length > 40) {
        pages.push({ url, title: (isHtml ? extractHtmlTitle(html) : null) ?? new URL(url).pathname, text });
      }
      if (isHtml && maxPages > 1) {
        for (const link of extractSameSiteLinks(html, url)) {
          if (!seen.has(link) && queue.length < 300) queue.push(link);
        }
      }
    } catch (err) {
      if (url === startUrl) startError = err;
    }
  }
  if (pages.length === 0) {
    throw new KnowledgeError(
      startError instanceof Error
        ? `No se pudo leer la página: ${startError.message}`
        : 'La página no tiene texto legible (puede requerir JavaScript para mostrar su contenido)',
      422
    );
  }
  return pages;
}

async function extractContent(versionId: string, allowedHosts: string[]): Promise<{ text: string; pageCount: number }> {
  const version = await prisma.knowledgeSourceVersion.findUnique({
    where: { id: versionId },
    include: { source: { select: { kind: true } } },
  });
  if (!version) throw new KnowledgeError('Versión no encontrada', 404);

  if (version.sourceUrl) {
    const start = new URL(version.sourceUrl);
    const hosts = allowedHosts.length > 0 ? allowedHosts : [start.hostname];
    const maxPages = version.source.kind === 'website' ? WEBSITE_MAX_PAGES : 1;
    const pages = await crawlPages(start.toString(), hosts, maxPages);
    const text = pages
      .map((p) => `# ${p.title.slice(0, 90)}\n\nFuente: ${p.url}\n\n${p.text}`)
      .join('\n\n');
    return { text, pageCount: pages.length };
  }

  if (!version.storageObjectId) throw new KnowledgeError('La versión no tiene contenido', 400);
  const object = await getStorageObject(version.storageObjectId);
  if (!object || object.status !== 'ready')
    throw new KnowledgeError('El archivo no está disponible', 409);
  const buffer = await readObjectToBuffer(object, MAX_TEXT_BYTES);
  const kind = fileKindOf(object.detectedMimeType ?? object.declaredMimeType, object.originalName);
  switch (kind) {
    case 'pdf':
      return { text: await extractPdf(buffer), pageCount: 0 };
    case 'word':
      return { text: htmlToText(await docxToHtml(buffer)), pageCount: 0 };
    case 'excel':
      return { text: sheetsToText(await readWorkbook(buffer)), pageCount: 0 };
    case 'csv':
      return {
        text: sheetsToText([{ name: object.originalName.replace(/\.csv$/i, ''), rows: parseCsv(buffer.toString('utf8'), MAX_SHEET_ROWS) }]),
        pageCount: 0,
      };
    case 'web':
      return { text: htmlToText(buffer.toString('utf8')), pageCount: 0 };
    default:
      return { text: normalizeText(buffer.toString('utf8')), pageCount: 0 };
  }
}

async function setCurrentVersion(sourceId: string, versionId: string, actorId: string, action: string) {
  const source = await prisma.knowledgeSource.update({
    where: { id: sourceId },
    data: {
      status: 'approved',
      currentVersionId: versionId,
      approvedBy: actorId,
      approvedAt: new Date(),
    },
  });
  await recordAuditEvent({
    actorUserId: actorId,
    action,
    targetType: 'knowledge_version',
    targetId: versionId,
    metadata: { sourceId },
  });
  return source;
}

/** Job body: extract text, chunk, store; auto-approve when requested; embed. */
export async function processVersion(
  versionId: string,
  allowedHosts: string[] = []
): Promise<{ chunks: number; pages: number }> {
  try {
    const { text, pageCount } = await extractContent(versionId, allowedHosts);
    if (text.trim().length === 0) {
      throw new KnowledgeError(
        'No se encontró texto legible. Si es un PDF escaneado, súbelo con texto seleccionable o como Word.',
        422
      );
    }
    const chunks = chunkText(text);
    const version = await prisma.knowledgeSourceVersion.findUnique({
      where: { id: versionId },
      select: { sourceId: true, autoApprove: true, createdBy: true, source: { select: { status: true } } },
    });
    if (!version) throw new KnowledgeError('Versión no encontrada', 404);
    await prisma.$transaction(async (tx) => {
      await tx.knowledgeChunk.deleteMany({ where: { versionId } });
      for (let i = 0; i < chunks.length; i += 200) {
        await tx.knowledgeChunk.createMany({
          data: chunks.slice(i, i + 200).map((c) => ({
            sourceId: version.sourceId,
            versionId,
            ordinal: c.ordinal,
            section: c.section,
            content: c.content,
            tokens: c.tokens,
          })),
        });
      }
      await tx.knowledgeSourceVersion.update({
        where: { id: versionId },
        data: { status: 'ready', chunkCount: chunks.length, pageCount, error: null },
      });
    });
    if (version.autoApprove && version.source.status !== 'archived') {
      await setCurrentVersion(version.sourceId, versionId, version.createdBy, 'knowledge.version_auto_approved');
    }
    // Semantic vectors (never block the lexical index; the backfill job retries later).
    try {
      await embedVersionChunks(versionId);
    } catch (err) {
      console.warn(JSON.stringify({ event: 'knowledge.embed_failed', versionId, message: err instanceof Error ? err.message : 'unknown' }));
    }
    return { chunks: chunks.length, pages: pageCount };
  } catch (err) {
    await prisma.knowledgeSourceVersion.update({
      where: { id: versionId },
      data: { status: 'failed', error: err instanceof Error ? err.message.slice(0, 500) : 'error' },
    });
    throw err;
  }
}

/** Approves a READY version as the current one; the source becomes approved. */
export async function approveVersion(actor: CurrentUser, sourceId: string, versionId: string) {
  const version = await prisma.knowledgeSourceVersion.findFirst({
    where: { id: versionId, sourceId },
  });
  if (!version) throw new KnowledgeError('Versión no encontrada', 404);
  if (version.status !== 'ready')
    throw new KnowledgeError('Solo se puede aprobar una versión procesada', 409);
  return setCurrentVersion(sourceId, versionId, actor.id, 'knowledge.version_approved');
}

/**
 * Deletes a source for good: versions and index (cascade) and its stored files. A file that
 * something else still references (e.g. it was attached to a sent message) is kept.
 */
export async function deleteSource(actor: CurrentUser, id: string) {
  const source = await prisma.knowledgeSource.findUnique({
    where: { id },
    select: { id: true, title: true, versions: { select: { storageObjectId: true } } },
  });
  if (!source) throw new KnowledgeError('Fuente no encontrada', 404);
  const objectIds = [...new Set(source.versions.map((v) => v.storageObjectId).filter((v): v is string => Boolean(v)))];
  await prisma.knowledgeSource.delete({ where: { id } });
  let filesDeleted = 0;
  let filesKept = 0;
  for (const objectId of objectIds) {
    try {
      let result = await deleteObjectIfUnreferenced(objectId);
      // Library files are "protected" from generic cleanup; unreferenced ones may go now.
      if (!result.deleted && result.references === 0) result = await deleteObjectIfUnreferenced(objectId, { force: true });
      if (result.deleted) filesDeleted += 1;
      else filesKept += 1;
    } catch (err) {
      filesKept += 1;
      console.warn(JSON.stringify({ event: 'knowledge.file_delete_failed', objectId, message: err instanceof Error ? err.message : 'unknown' }));
    }
  }
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'knowledge.source_deleted',
    targetType: 'knowledge_source',
    targetId: id,
    metadata: { title: source.title, versions: source.versions.length, filesDeleted, filesKept },
  });
  return { deleted: true, filesDeleted, filesKept };
}

export async function listSources(filters: { status?: string; visibility?: string; id?: string } = {}) {
  const rows = await prisma.knowledgeSource.findMany({
    where: {
      ...(filters.id ? { id: filters.id } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.visibility ? { visibility: filters.visibility } : {}),
    },
    include: {
      versions: {
        orderBy: { version: 'desc' },
        select: {
          id: true,
          version: true,
          status: true,
          chunkCount: true,
          error: true,
          storageObjectId: true,
          sourceUrl: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
          pageCount: true,
          autoApprove: true,
          createdAt: true,
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    kind: s.kind,
    visibility: s.visibility,
    status: s.status,
    currentVersionId: s.currentVersionId,
    tags: s.tags,
    category: s.category,
    useWhen: s.useWhen,
    expiresAt: s.expiresAt?.toISOString() ?? null,
    createdBy: s.createdBy,
    approvedBy: s.approvedBy,
    approvedAt: s.approvedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    versions: s.versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
  }));
}

/** Source with its versions and the fragments the assistant reads for one version. */
export async function getSourceDetail(id: string, versionId?: string | null) {
  const [source] = await listSources({ id });
  if (!source) throw new KnowledgeError('Fuente no encontrada', 404);
  const selected =
    source.versions.find((v) => v.id === versionId) ??
    source.versions.find((v) => v.id === source.currentVersionId) ??
    source.versions[0] ??
    null;
  const chunks = selected
    ? await prisma.knowledgeChunk.findMany({
        where: { versionId: selected.id },
        orderBy: { ordinal: 'asc' },
        take: MAX_DETAIL_CHUNKS,
        select: { ordinal: true, section: true, content: true },
      })
    : [];
  return { source, versionId: selected?.id ?? null, chunks, totalChunks: selected?.chunkCount ?? 0 };
}

export type KnowledgePreview =
  | { type: 'pdf'; url: string; fileName: string }
  | { type: 'html'; html: string; fileName: string }
  | { type: 'table'; sheets: SheetPreview[]; fileName: string }
  | { type: 'text'; text: string; truncated: boolean; fileName: string | null }
  | { type: 'web'; url: string; pageCount: number; text: string; truncated: boolean }
  | { type: 'none'; message: string };

/** Chunks overlap by a short tail; rebuild readable text for previews. */
function joinChunks(chunks: Array<{ content: string }>): string {
  let out = '';
  let previous = '';
  for (const chunk of chunks) {
    let content = chunk.content;
    const tail = previous.slice(-200).trim();
    if (tail && content.startsWith(tail)) content = content.slice(tail.length).replace(/^\s+/, '');
    out += (out ? '\n\n' : '') + content;
    previous = chunk.content;
  }
  return out;
}

function clipText(text: string): { text: string; truncated: boolean } {
  return { text: text.slice(0, PREVIEW_TEXT_CHARS), truncated: text.length > PREVIEW_TEXT_CHARS };
}

/** What a person sees when opening a version: the PDF itself, the Word document, the sheet, the text. */
export async function getVersionPreview(sourceId: string, versionId?: string | null): Promise<KnowledgePreview> {
  const source = await prisma.knowledgeSource.findUnique({
    where: { id: sourceId },
    select: {
      currentVersionId: true,
      versions: {
        orderBy: { version: 'desc' },
        select: { id: true, status: true, storageObjectId: true, sourceUrl: true, pageCount: true },
      },
    },
  });
  if (!source) throw new KnowledgeError('Fuente no encontrada', 404);
  const version =
    source.versions.find((v) => v.id === versionId) ??
    source.versions.find((v) => v.id === source.currentVersionId) ??
    source.versions[0];
  if (!version) return { type: 'none', message: 'Esta fuente todavía no tiene contenido.' };

  if (version.sourceUrl) {
    if (version.status !== 'ready') {
      return {
        type: 'none',
        message: version.status === 'processing' ? 'Leyendo la página… en unos segundos verás su contenido.' : 'No se pudo leer esta página.',
      };
    }
    const chunks = await prisma.knowledgeChunk.findMany({
      where: { versionId: version.id },
      orderBy: { ordinal: 'asc' },
      select: { content: true },
    });
    return { type: 'web', url: version.sourceUrl, pageCount: version.pageCount, ...clipText(joinChunks(chunks)) };
  }

  if (!version.storageObjectId) return { type: 'none', message: 'Esta versión no tiene archivo.' };
  const object = await getStorageObject(version.storageObjectId);
  if (!object || object.status !== 'ready') return { type: 'none', message: 'El archivo no está disponible.' };
  const fileName = object.originalName;
  const kind = fileKindOf(object.detectedMimeType ?? object.declaredMimeType, fileName);
  if (kind === 'pdf') return { type: 'pdf', url: `/app/files/api/objects/${object.id}/content`, fileName };

  const buffer = await readObjectToBuffer(object, MAX_TEXT_BYTES);
  try {
    if (kind === 'word') return { type: 'html', html: (await docxToHtml(buffer)).slice(0, 2_000_000), fileName };
    if (kind === 'excel') {
      const sheets = await readWorkbook(buffer);
      return { type: 'table', sheets: sheets.map((s) => sheetPreview(s, PREVIEW_TABLE_ROWS)), fileName };
    }
    if (kind === 'csv') {
      const rows = parseCsv(buffer.toString('utf8'), MAX_SHEET_ROWS);
      return { type: 'table', sheets: [sheetPreview({ name: fileName, rows }, PREVIEW_TABLE_ROWS)], fileName };
    }
    if (kind === 'web') return { type: 'text', fileName, ...clipText(htmlToText(buffer.toString('utf8'))) };
    return { type: 'text', fileName, ...clipText(buffer.toString('utf8')) };
  } catch (err) {
    return { type: 'none', message: `No se pudo mostrar el archivo: ${err instanceof Error ? err.message : 'formato no legible'}` };
  }
}

/* ------------------------------------------------------------------ */
/* Documents the assistant can send                                   */
/* ------------------------------------------------------------------ */

export interface ShareableDocument {
  knowledgeSourceId: string;
  title: string;
  description: string | null;
  tags: string[];
  category: string | null;
  useWhen: string | null;
  visibility: string;
  version: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: string | null;
}

/**
 * Approved, non-expired sources whose APPROVED version is a ready file. Publishable only unless
 * `includeInternal`. With `search`, ranked by relevance (title/tags/category/"cuándo usarlo").
 */
export async function listShareableDocuments(options: { includeInternal?: boolean; search?: string } = {}): Promise<ShareableDocument[]> {
  const now = new Date();
  const sources = await prisma.knowledgeSource.findMany({
    where: {
      status: 'approved',
      currentVersionId: { not: null },
      ...(options.includeInternal ? {} : { visibility: 'publishable' }),
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, title: true, description: true, tags: true, category: true, useWhen: true, visibility: true, currentVersionId: true, expiresAt: true },
  });
  const versionIds = sources.map((s) => s.currentVersionId).filter((v): v is string => Boolean(v));
  const versions = versionIds.length
    ? await prisma.knowledgeSourceVersion.findMany({
        where: { id: { in: versionIds }, status: 'ready', storageObjectId: { not: null } },
        select: { id: true, version: true, storageObjectId: true },
      })
    : [];
  const objectIds = versions.map((v) => v.storageObjectId).filter((v): v is string => Boolean(v));
  const objects = objectIds.length
    ? await prisma.storageObject.findMany({
        where: { id: { in: objectIds }, status: 'ready' },
        select: { id: true, originalName: true, declaredMimeType: true, detectedMimeType: true, sizeBytes: true },
      })
    : [];
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const objectById = new Map(objects.map((o) => [o.id, o]));

  const docs: ShareableDocument[] = [];
  for (const s of sources) {
    const version = s.currentVersionId ? versionById.get(s.currentVersionId) : undefined;
    const object = version?.storageObjectId ? objectById.get(version.storageObjectId) : undefined;
    if (!version || !object) continue;
    docs.push({
      knowledgeSourceId: s.id,
      title: s.title,
      description: s.description,
      tags: s.tags,
      category: s.category,
      useWhen: s.useWhen,
      visibility: s.visibility,
      version: version.version,
      fileName: object.originalName,
      mimeType: object.detectedMimeType ?? object.declaredMimeType,
      sizeBytes: Number(object.sizeBytes),
      expiresAt: s.expiresAt?.toISOString() ?? null,
    });
  }
  if (!options.search?.trim()) return docs;
  const byId = new Map(docs.map((d) => [d.knowledgeSourceId, d]));
  return rankShareable(
    options.search,
    docs.map((d) => ({ ...d, id: d.knowledgeSourceId }))
  ).ranked.map((r) => byId.get(r.id)!);
}

export interface ShareableSearchResult {
  request: string;
  decision: ShareableDecision;
  totalShareable: number;
  matches: Array<Pick<ShareableDocument, 'knowledgeSourceId' | 'title' | 'category' | 'useWhen' | 'fileName' | 'version'> & { score: number }>;
  instruction: string;
}

/** Picks THE authorized file for "mándale el PDF de promociones al cliente". */
export async function findShareableDocuments(request: string, limit = 3): Promise<ShareableSearchResult> {
  const docs = await listShareableDocuments();
  const { decision, ranked } = rankShareable(
    request,
    docs.map((d) => ({ ...d, id: d.knowledgeSourceId }))
  );
  const matches = ranked.slice(0, Math.min(Math.max(limit, 1), 5)).map((d) => ({
    knowledgeSourceId: d.knowledgeSourceId,
    title: d.title,
    category: d.category,
    useWhen: d.useWhen,
    fileName: d.fileName,
    version: d.version,
    score: d.score,
  }));
  const instruction =
    decision === 'single'
      ? `Usa attachments.knowledgeSourceIds = ["${matches[0].knowledgeSourceId}"] al preparar el envío (sendMessageToContact / sendInboxMessage) y dile al usuario qué archivo va: "${matches[0].title}" (${matches[0].fileName}).`
      : decision === 'ambiguous'
        ? 'Hay varios archivos posibles. Pregúntale al usuario cuál quiere mostrando sus títulos; no elijas tú ni prepares el envío todavía.'
        : docs.length === 0
          ? 'No hay ningún archivo autorizado para compartir en la biblioteca. Dile al usuario que un administrador debe subirlo como Publicable y aprobarlo. No mandes otro archivo en su lugar.'
          : 'Ningún archivo autorizado coincide con lo que pidió. Díselo con claridad y ofrece la lista (listAttachableDocuments). No mandes otro archivo, un reporte ni un documento interno en su lugar.';
  return { request, decision, totalShareable: docs.length, matches, instruction };
}

/** The file of the APPROVED version of a source (never a newer upload still under review). */
export async function resolveApprovedDocumentFile(sourceId: string) {
  const source = await prisma.knowledgeSource.findUnique({
    where: { id: sourceId },
    select: { title: true, visibility: true, status: true, currentVersionId: true, expiresAt: true },
  });
  if (!source) return null;
  const version = source.currentVersionId
    ? await prisma.knowledgeSourceVersion.findFirst({
        where: { id: source.currentVersionId, sourceId, status: 'ready' },
        select: { storageObjectId: true },
      })
    : null;
  return {
    title: source.title,
    visibility: source.visibility,
    status: source.status,
    expired: Boolean(source.expiresAt && source.expiresAt.getTime() <= Date.now()),
    storageObjectId: version?.storageObjectId ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Search                                                             */
/* ------------------------------------------------------------------ */

export interface KnowledgeHit {
  sourceId: string;
  title: string;
  visibility: string;
  version: number;
  section: string | null;
  excerpt: string;
  rank: number;
  /** How the fragment was found: exact words, meaning, or both. */
  match?: 'lexical' | 'semantic' | 'hybrid';
}

interface ChunkRow {
  chunkId: string;
  sourceId: string;
  title: string;
  visibility: string;
  version: number;
  section: string | null;
  content: string;
  rank: number;
}

function toHit(r: ChunkRow, rank: number, match: KnowledgeHit['match']): KnowledgeHit {
  return {
    sourceId: r.sourceId,
    title: r.title,
    visibility: r.visibility,
    version: r.version,
    section: r.section,
    excerpt: r.content.length > 1200 ? `${r.content.slice(0, 1200)}…` : r.content,
    rank,
    match,
  };
}

/**
 * Accent-folded tsvector of a chunk. Query terms are folded too (buildTsQuery), so "garantía de
 * instalación" and "años" match. Before, the query was folded but the content was not, and any
 * accented word never matched ("garantia:*" vs 'garant', "anos:*" vs 'años').
 * Must stay identical to the expression of the KnowledgeChunk_content_fts_folded_idx index.
 */
const FOLDED_TSVECTOR = Prisma.sql`to_tsvector('spanish', translate(lower(c."content"), 'áéíóúüñ', 'aeiouun'))`;

/** Lexical (tsvector) candidates, ranked: fragments with every term first; if none, any term. */
async function lexicalCandidates(query: string, visibility: 'internal' | 'publishable' | undefined, limit: number): Promise<ChunkRow[]> {
  const everyTerm = buildTsQuery(query, 'and');
  if (!everyTerm) return [];
  const visibilityFilter = visibility === 'publishable' ? Prisma.sql`AND s."visibility" = 'publishable'` : Prisma.empty;
  const now = new Date();
  const run = (tsquery: string) => prisma.$queryRaw<ChunkRow[]>`
    SELECT c."id" AS "chunkId", s."id" AS "sourceId", s."title", s."visibility", v."version", c."section", c."content",
           ts_rank_cd(${FOLDED_TSVECTOR}, to_tsquery('spanish', ${tsquery})) AS "rank"
    FROM "KnowledgeChunk" c
    JOIN "KnowledgeSourceVersion" v ON v."id" = c."versionId"
    JOIN "KnowledgeSource" s ON s."id" = c."sourceId" AND s."currentVersionId" = v."id"
    WHERE s."status" = 'approved' AND v."status" = 'ready'
      AND (s."expiresAt" IS NULL OR s."expiresAt" > ${now})
      AND ${FOLDED_TSVECTOR} @@ to_tsquery('spanish', ${tsquery})
      ${visibilityFilter}
    ORDER BY "rank" DESC
    LIMIT ${limit}
  `;
  const strict = await run(everyTerm);
  if (strict.length > 0) return strict;
  const anyTerm = buildTsQuery(query, 'or');
  return anyTerm && anyTerm !== everyTerm ? run(anyTerm) : strict;
}

const SEMANTIC_SCAN_LIMIT = 6000;

/** Semantic candidates: cosine similarity between the query vector and every embedded chunk of the approved library. */
async function semanticCandidates(query: string, visibility: 'internal' | 'publishable' | undefined, limit: number): Promise<ChunkRow[]> {
  const vector = await embedQuery(query);
  if (!vector) return [];
  const rows = await prisma.knowledgeChunk.findMany({
    where: {
      embeddingModel: { not: null },
      version: {
        status: 'ready',
        source: {
          status: 'approved',
          ...(visibility === 'publishable' ? { visibility: 'publishable' } : {}),
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      },
    },
    select: {
      id: true,
      section: true,
      content: true,
      embedding: true,
      version: { select: { id: true, version: true, source: { select: { id: true, title: true, visibility: true, currentVersionId: true } } } },
    },
    take: SEMANTIC_SCAN_LIMIT,
  });
  const scored: ChunkRow[] = [];
  for (const r of rows) {
    if (r.version.source.currentVersionId !== r.version.id) continue;
    const sim = cosineSimilarity(vector, r.embedding);
    if (sim < 0.2) continue;
    scored.push({
      chunkId: r.id,
      sourceId: r.version.source.id,
      title: r.version.source.title,
      visibility: r.version.source.visibility,
      version: r.version.version,
      section: r.section,
      content: r.content,
      rank: sim,
    });
  }
  scored.sort((a, b) => b.rank - a.rank);
  return scored.slice(0, limit);
}

/** Optional LLM re-ranking of the fused top candidates (admin setting `ragRerankEnabled`). */
async function rerankWithModel(query: string, candidates: ChunkRow[]): Promise<Map<string, number> | null> {
  if (candidates.length < 2) return null;
  try {
    const { chatCompletion } = await import('@/modules/ai/ai-client');
    const settings = await getAiSettings();
    const listing = candidates
      .map((c, i) => `[${i}] (${c.title}${c.section ? ` › ${c.section}` : ''}) ${c.content.replace(/\s+/g, ' ').slice(0, 700)}`)
      .join('\n\n');
    const res = await chatCompletion({
      model: settings.qualityJudgeModel?.trim() || settings.fallbackDeployment || settings.deployment,
      temperature: 0,
      maxTokens: 400,
      messages: [
        {
          role: 'system',
          content:
            'Eres un re-ranker. Para cada fragmento numerado, califica de 0 a 10 qué tan bien responde la pregunta. Responde SOLO JSON: {"scores":{"0":n,"1":n,...}}.',
        },
        { role: 'user', content: `Pregunta: ${query}\n\nFragmentos:\n${listing}` },
      ],
    });
    const text = res.content ?? '';
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json) as { scores?: Record<string, number> };
    if (!parsed.scores) return null;
    const out = new Map<string, number>();
    candidates.forEach((c, i) => {
      const v = Number(parsed.scores?.[String(i)]);
      if (Number.isFinite(v)) out.set(c.chunkId, v);
    });
    return out;
  } catch (err) {
    console.warn(JSON.stringify({ event: 'knowledge.rerank_failed', message: err instanceof Error ? err.message : 'unknown' }));
    return null;
  }
}

/**
 * Hybrid search over the approved, non-expired library: lexical (tsvector, exact words) +
 * semantic (embeddings, meaning) fused with Reciprocal Rank Fusion, with an optional model
 * re-ranking of the top candidates. Falls back to lexical-only when embeddings are not
 * configured or fail, so results never disappear. `visibility` narrows to publishable-only
 * content when the answer is meant for a customer.
 */
export async function searchKnowledge(
  query: string,
  options: { visibility?: 'internal' | 'publishable'; limit?: number; mode?: 'hybrid' | 'lexical' } = {}
): Promise<KnowledgeHit[]> {
  const cleanQuery = query.trim();
  if (cleanQuery.length < 2) return [];
  const limit = Math.min(options.limit ?? 8, 20);
  const candidateLimit = Math.max(limit * 3, 12);
  const settings = await getAiSettings().catch(() => null);
  const semanticOn = options.mode !== 'lexical' && (settings?.ragSemanticEnabled ?? false);

  const [lexical, semantic] = await Promise.all([
    lexicalCandidates(cleanQuery, options.visibility, candidateLimit).catch((err) => {
      console.warn(JSON.stringify({ event: 'knowledge.lexical_failed', message: err instanceof Error ? err.message : 'unknown' }));
      return [] as ChunkRow[];
    }),
    semanticOn
      ? semanticCandidates(cleanQuery, options.visibility, candidateLimit).catch((err) => {
          console.warn(JSON.stringify({ event: 'knowledge.semantic_failed', message: err instanceof Error ? err.message : 'unknown' }));
          return [] as ChunkRow[];
        })
      : Promise.resolve([] as ChunkRow[]),
  ]);

  if (lexical.length === 0 && semantic.length === 0) return [];
  if (semantic.length === 0) return lexical.slice(0, limit).map((r, i) => toHit(r, Number(r.rank) || 1 / (i + 1), 'lexical'));
  if (lexical.length === 0) return semantic.slice(0, limit).map((r) => toHit(r, r.rank, 'semantic'));

  const fused = reciprocalRankFusion([
    lexical.map((r) => ({ key: r.chunkId, item: r })),
    semantic.map((r) => ({ key: r.chunkId, item: r })),
  ]);
  let top = fused.slice(0, Math.max(limit, 10));

  if (settings?.ragRerankEnabled) {
    const scores = await rerankWithModel(cleanQuery, top.map((f) => f.item));
    if (scores) {
      top = [...top].sort((a, b) => (scores.get(b.key) ?? 0) - (scores.get(a.key) ?? 0) || b.score - a.score);
    }
  }

  return top.slice(0, limit).map((f) => toHit(f.item, f.score, f.sources.length > 1 ? 'hybrid' : f.sources[0] === 0 ? 'lexical' : 'semantic'));
}
