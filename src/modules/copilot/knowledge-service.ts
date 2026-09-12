import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { hasPermission } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { enqueueJob, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import {
  getStorageObject,
  readObjectToBuffer,
  saveGeneratedFile,
} from '@/modules/storage/storage-service';
import {
  registerFileAccessResolver,
  registerUploadTargetResolver,
} from '@/modules/storage/storage-access';
import { StorageError } from '@/modules/storage/storage-service';
import { safeFetch } from '@/modules/extensions/safe-fetch';
import { bufferRandomAccess, readZipDirectory, readZipEntry } from '@/modules/storage/zip-reader';
import { buildTsQuery, chunkText, normalizeText } from './knowledge-chunker';

/**
 * Approved knowledge library.
 *
 * Sources (documents, URLs, texts) have versions; a version is processed
 * (text extraction + chunking) by a background job and becomes searchable
 * ONLY after an administrator approves it. `visibility` separates internal
 * information from publishable content. A document a customer sent in a chat
 * never enters the library by itself: someone with `knowledge.manage` must
 * add it explicitly.
 */

export const KNOWLEDGE_PROCESS_JOB = 'knowledge.process_version';
const MAX_TEXT_BYTES = 40 * 1024 * 1024;
const MAX_URL_BYTES = 5 * 1024 * 1024;

export class KnowledgeError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

export const createSourceSchema = z.object({
  title: z.string().min(2).max(200),
  description: z.string().max(2000).optional(),
  kind: z.enum(['document', 'url', 'text']),
  visibility: z.enum(['internal', 'publishable']).default('internal'),
  tags: z.array(z.string().max(40)).max(20).default([]),
});

export const createVersionSchema = z
  .object({
    storageObjectId: z.string().optional(),
    text: z.string().max(2_000_000).optional(),
    url: z.string().url().optional(),
    allowedHosts: z.array(z.string().max(253)).max(5).optional(),
  })
  .refine((v) => Boolean(v.storageObjectId || v.text || v.url), {
    message: 'Indica un archivo, un texto o una URL',
  });

registerUploadTargetResolver('knowledge_source', async (actor, sourceId) => {
  if (!hasPermission(actor, 'knowledge.manage'))
    throw new StorageError('Sin permiso', 'forbidden', 403);
  const source = await prisma.knowledgeSource.findUnique({
    where: { id: sourceId },
    select: { id: true },
  });
  if (!source) throw new StorageError('Fuente no encontrada', 'not_found', 404);
  return {
    policy: {
      purpose: 'knowledge',
      maxBytes: MAX_TEXT_BYTES,
      allowedMimeTypes: [
        'application/pdf',
        'text/plain',
        'text/markdown',
        'text/csv',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      retentionPolicy: 'protected',
    },
  };
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

export async function createSource(actor: CurrentUser, input: z.infer<typeof createSourceSchema>) {
  const source = await prisma.knowledgeSource.create({
    data: { ...input, description: input.description ?? null, createdBy: actor.id },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'knowledge.source_created',
    targetType: 'knowledge_source',
    targetId: source.id,
  });
  return source;
}

export async function updateSource(
  actor: CurrentUser,
  id: string,
  patch: Partial<z.infer<typeof createSourceSchema>> & {
    status?: 'draft' | 'approved' | 'archived';
  }
) {
  const source = await prisma.knowledgeSource.findUnique({ where: { id } });
  if (!source) throw new KnowledgeError('Fuente no encontrada', 404);
  const updated = await prisma.knowledgeSource.update({
    where: { id },
    data: {
      title: patch.title,
      description: patch.description,
      visibility: patch.visibility,
      tags: patch.tags,
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
  if (storageObjectId) {
    const object = await getStorageObject(storageObjectId);
    if (!object || object.status !== 'ready' || object.purpose !== 'knowledge') {
      throw new KnowledgeError('El archivo no está listo o no pertenece a la biblioteca', 409);
    }
  } else if (input.text) {
    const object = await saveGeneratedFile({
      createdBy: actor.id,
      purpose: 'knowledge',
      fileName: `${source.title.replace(/[^A-Za-z0-9]+/g, '_')}.txt`,
      mimeType: 'text/plain',
      source: { buffer: Buffer.from(input.text, 'utf8') },
      retentionPolicy: 'protected',
    });
    storageObjectId = object.id;
  }
  const version = await prisma.knowledgeSourceVersion.create({
    data: {
      sourceId,
      version: (source.versions[0]?.version ?? 0) + 1,
      storageObjectId,
      sourceUrl: input.url ?? null,
      status: 'processing',
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
    metadata: { sourceId, kind: source.kind },
  });
  return version;
}

function stripXml(xml: string): string {
  return xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function extractText(versionId: string, allowedHosts: string[]): Promise<string> {
  const version = await prisma.knowledgeSourceVersion.findUnique({ where: { id: versionId } });
  if (!version) throw new KnowledgeError('Versión no encontrada', 404);
  if (version.sourceUrl) {
    const url = new URL(version.sourceUrl);
    const hosts = allowedHosts.length > 0 ? allowedHosts : [url.hostname];
    const res = await safeFetch(
      version.sourceUrl,
      { method: 'GET' },
      {
        allowedHosts: hosts,
        maxResponseBytes: MAX_URL_BYTES,
        timeoutMs: 20_000,
        allowedContentTypes: ['text/', 'application/json', 'application/xml'],
      }
    );
    const html = res.body.toString('utf8');
    return normalizeText(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
    );
  }
  if (!version.storageObjectId) throw new KnowledgeError('La versión no tiene contenido', 400);
  const object = await getStorageObject(version.storageObjectId);
  if (!object || object.status !== 'ready')
    throw new KnowledgeError('El archivo no está disponible', 409);
  const buffer = await readObjectToBuffer(object, MAX_TEXT_BYTES);
  const mime = object.detectedMimeType ?? object.declaredMimeType;
  if (mime === 'application/pdf') {
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
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const access = bufferRandomAccess(buffer);
    const dir = await readZipDirectory(access);
    const entry = dir.entries.find((e) => e.name === 'word/document.xml');
    if (!entry) throw new KnowledgeError('DOCX sin document.xml', 400);
    const xml = (await readZipEntry(access, entry, 20 * 1024 * 1024)).toString('utf8');
    return normalizeText(stripXml(xml));
  }
  return normalizeText(buffer.toString('utf8'));
}

/** Job body: extract text, chunk, store. */
export async function processVersion(
  versionId: string,
  allowedHosts: string[] = []
): Promise<{ chunks: number }> {
  try {
    const text = await extractText(versionId, allowedHosts);
    if (text.length === 0) throw new KnowledgeError('No se pudo extraer texto de la fuente', 422);
    const chunks = chunkText(text);
    const version = await prisma.knowledgeSourceVersion.findUnique({
      where: { id: versionId },
      select: { sourceId: true },
    });
    if (!version) throw new KnowledgeError('Versión no encontrada', 404);
    await prisma.$transaction(async (tx) => {
      await tx.knowledgeChunk.deleteMany({ where: { versionId } });
      for (let i = 0; i < chunks.length; i += 200) {
        await tx.knowledgeChunk.createMany({
          data: chunks
            .slice(i, i + 200)
            .map((c) => ({
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
        data: { status: 'ready', chunkCount: chunks.length, error: null },
      });
    });
    return { chunks: chunks.length };
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
  const source = await prisma.knowledgeSource.update({
    where: { id: sourceId },
    data: {
      status: 'approved',
      currentVersionId: versionId,
      approvedBy: actor.id,
      approvedAt: new Date(),
    },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'knowledge.version_approved',
    targetType: 'knowledge_version',
    targetId: versionId,
    metadata: { sourceId },
  });
  return source;
}

export async function listSources(filters: { status?: string; visibility?: string } = {}) {
  const rows = await prisma.knowledgeSource.findMany({
    where: {
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
    createdBy: s.createdBy,
    approvedBy: s.approvedBy,
    approvedAt: s.approvedAt?.toISOString() ?? null,
    updatedAt: s.updatedAt.toISOString(),
    versions: s.versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
  }));
}

export interface KnowledgeHit {
  sourceId: string;
  title: string;
  visibility: string;
  version: number;
  section: string | null;
  excerpt: string;
  rank: number;
}

/**
 * Full-text search over APPROVED current versions. `visibility` narrows to
 * publishable-only content when the answer is meant for a customer.
 */
export async function searchKnowledge(
  query: string,
  options: { visibility?: 'internal' | 'publishable'; limit?: number } = {}
): Promise<KnowledgeHit[]> {
  const tsquery = buildTsQuery(query);
  if (!tsquery) return [];
  const limit = Math.min(options.limit ?? 8, 20);
  const visibilityFilter =
    options.visibility === 'publishable'
      ? Prisma.sql`AND s."visibility" = 'publishable'`
      : Prisma.empty;
  const rows = await prisma.$queryRaw<
    Array<{
      sourceId: string;
      title: string;
      visibility: string;
      version: number;
      section: string | null;
      content: string;
      rank: number;
    }>
  >`
    SELECT s."id" AS "sourceId", s."title", s."visibility", v."version", c."section", c."content",
           ts_rank_cd(to_tsvector('spanish', c."content"), to_tsquery('spanish', ${tsquery})) AS "rank"
    FROM "KnowledgeChunk" c
    JOIN "KnowledgeSourceVersion" v ON v."id" = c."versionId"
    JOIN "KnowledgeSource" s ON s."id" = c."sourceId" AND s."currentVersionId" = v."id"
    WHERE s."status" = 'approved' AND v."status" = 'ready'
      AND to_tsvector('spanish', c."content") @@ to_tsquery('spanish', ${tsquery})
      ${visibilityFilter}
    ORDER BY "rank" DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    sourceId: r.sourceId,
    title: r.title,
    visibility: r.visibility,
    version: r.version,
    section: r.section,
    excerpt: r.content.length > 1200 ? `${r.content.slice(0, 1200)}…` : r.content,
    rank: Number(r.rank),
  }));
}
