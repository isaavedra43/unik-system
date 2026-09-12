import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { Prisma, type StudioExport } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { cancelJob, enqueueJob, JOB_PRIORITY, waitForJob } from '@/modules/jobs/job-queue';
import { publishRealtime, REALTIME_CHANNELS } from '@/modules/realtime/realtime-service';
import {
  getStorageObject,
  readObjectToBuffer,
  saveGeneratedFile,
} from '@/modules/storage/storage-service';
import { parseStudioContent, type StudioContent } from './studio-content';
import {
  EXPORT_FORMAT_INFO,
  exportFileName,
  isStudioExportFormat,
  renderStudioExport,
  type ExportImage,
  type ExportRenderInput,
  type ExportRenderResult,
  type StudioExportFormat,
} from './studio-exporters';
import { canViewDocument, assertStudioUser, StudioError } from './studio-service';
import {
  verifyStudioExport,
  type VerificationInput,
  type VerificationResult,
} from './studio-verification';

/**
 * Exports: a StudioExport row is created `processing`, a `studio.export` job
 * renders the file in a temporary directory, VERIFIES it by reopening it, and
 * only then stores it (object storage) and marks the row `ready`. If the
 * worker does not pick the job up quickly (disabled, busy, another instance),
 * the request runs the very same function inline so the user always gets an
 * answer — the job is cancelled atomically first so it never runs twice.
 */

export const STUDIO_EXPORT_JOB = 'studio.export';
const INLINE_WAIT_MS = 4_000;
const RUNNING_WAIT_MS = 25_000;
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export interface StudioExportDTO {
  id: string;
  documentId: string;
  versionId: string;
  format: StudioExportFormat;
  formatLabel: string;
  status: 'processing' | 'ready' | 'failed';
  storageObjectId: string | null;
  verification: VerificationResult | null;
  error: string | null;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
  fileName: string | null;
  /** Only present when ready: resolves a short-lived download authorization. */
  accessPath: string | null;
}

export interface ExportRunnerDeps {
  render?: (format: StudioExportFormat, input: ExportRenderInput) => Promise<ExportRenderResult>;
  verify?: (
    format: StudioExportFormat,
    filePath: string,
    input: VerificationInput
  ) => Promise<VerificationResult>;
}

function toDTO(row: StudioExport, title: string | null): StudioExportDTO {
  const format = isStudioExportFormat(row.format) ? row.format : 'pdf';
  const status = row.status === 'ready' || row.status === 'failed' ? row.status : 'processing';
  return {
    id: row.id,
    documentId: row.documentId,
    versionId: row.versionId,
    format,
    formatLabel: EXPORT_FORMAT_INFO[format].label,
    status,
    storageObjectId: status === 'ready' ? row.storageObjectId : null,
    verification: (row.verification as unknown as VerificationResult | null) ?? null,
    error: row.error,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    fileName: title ? exportFileName(title, format) : null,
    accessPath:
      status === 'ready' && row.storageObjectId
        ? `/app/files/api/objects/${encodeURIComponent(row.storageObjectId)}/access?disposition=attachment`
        : null,
  };
}

async function loadViewableDocument(actor: CurrentUser, documentId: string) {
  assertStudioUser(actor);
  const doc = await prisma.studioDocument.findUnique({ where: { id: documentId } });
  if (!doc || !canViewDocument(actor, doc))
    throw new StudioError('Documento no encontrado', 'not_found', 404);
  return doc;
}

export async function listExports(
  actor: CurrentUser,
  documentId: string
): Promise<StudioExportDTO[]> {
  const doc = await loadViewableDocument(actor, documentId);
  const rows = await prisma.studioExport.findMany({
    where: { documentId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return rows.map((r) => toDTO(r, doc.title));
}

export async function getExport(actor: CurrentUser, exportId: string): Promise<StudioExportDTO> {
  assertStudioUser(actor);
  const row = await prisma.studioExport.findUnique({
    where: { id: exportId },
    include: { document: true },
  });
  if (!row || !canViewDocument(actor, row.document))
    throw new StudioError('Exportación no encontrada', 'not_found', 404);
  return toDTO(row, row.document.title);
}

/** Creates the export row, enqueues the job and falls back to inline execution. */
export async function requestExport(
  actor: CurrentUser,
  documentId: string,
  format: StudioExportFormat
): Promise<StudioExportDTO> {
  if (!isStudioExportFormat(format)) throw new StudioError('Formato no soportado', 'invalid', 400);
  const doc = await loadViewableDocument(actor, documentId);
  if (!doc.currentVersionId) throw new StudioError('El documento no tiene contenido', 'state', 409);

  const row = await prisma.studioExport.create({
    data: {
      documentId: doc.id,
      versionId: doc.currentVersionId,
      format,
      status: 'processing',
      createdBy: actor.id,
    },
  });
  const job = await enqueueJob({
    type: STUDIO_EXPORT_JOB,
    payload: { exportId: row.id },
    priority: JOB_PRIORITY.interactive,
    dedupeKey: `${STUDIO_EXPORT_JOB}:${row.id}`,
    groupKey: `studio:${doc.id}`,
    createdBy: actor.id,
  });

  const finished = await waitForJob(job.id, INLINE_WAIT_MS);
  if (!finished) {
    // Still pending → take it over inline. If a worker already claimed it, wait for it instead.
    const cancelled = await cancelJob(job.id);
    if (cancelled) {
      await runStudioExport(row.id);
    } else {
      await waitForJob(job.id, RUNNING_WAIT_MS);
    }
  }
  return getExport(actor, row.id);
}

async function loadImage(storageObjectId: string): Promise<ExportImage | null> {
  const object = await getStorageObject(storageObjectId);
  if (!object || object.status !== 'ready' || object.purpose !== 'document') return null;
  const buffer = await readObjectToBuffer(object, IMAGE_MAX_BYTES);
  return { buffer, mimeType: object.detectedMimeType ?? object.declaredMimeType };
}

async function finishExport(
  exportId: string,
  data: Prisma.StudioExportUpdateInput
): Promise<StudioExport> {
  return prisma.studioExport.update({
    where: { id: exportId },
    data: { ...data, completedAt: new Date() },
  });
}

async function notify(row: StudioExport): Promise<void> {
  try {
    await publishRealtime(REALTIME_CHANNELS.user(row.createdBy), 'studio.export', {
      exportId: row.id,
      documentId: row.documentId,
      status: row.status,
    });
  } catch {
    // Realtime is best-effort; the client also polls.
  }
}

/**
 * Renders, verifies and stores one export. Idempotent: an export that is no
 * longer `processing` is returned untouched.
 */
export async function runStudioExport(
  exportId: string,
  deps: ExportRunnerDeps = {}
): Promise<StudioExportDTO> {
  const row = await prisma.studioExport.findUnique({
    where: { id: exportId },
    include: { document: true },
  });
  if (!row) throw new StudioError('Exportación no encontrada', 'not_found', 404);
  if (row.status !== 'processing') return toDTO(row, row.document.title);
  if (!isStudioExportFormat(row.format)) {
    const failed = await finishExport(exportId, {
      status: 'failed',
      error: 'Formato no soportado',
    });
    return toDTO(failed, row.document.title);
  }
  const format = row.format;
  const version = await prisma.studioDocumentVersion.findUnique({ where: { id: row.versionId } });
  if (!version) {
    const failed = await finishExport(exportId, {
      status: 'failed',
      error: 'La versión ya no existe',
    });
    return toDTO(failed, row.document.title);
  }

  const render = deps.render ?? renderStudioExport;
  const verify = deps.verify ?? verifyStudioExport;
  const title = row.document.title;
  let content: StudioContent;
  try {
    content = parseStudioContent(version.content);
  } catch (err) {
    const failed = await finishExport(exportId, {
      status: 'failed',
      error: err instanceof Error ? err.message : 'Contenido inválido',
    });
    return toDTO(failed, title);
  }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unik-studio-export-'));
  const fileName = exportFileName(title, format);
  const outputPath = path.join(dir, fileName);
  try {
    const rendered = await render(format, { title, content, outputPath, loadImage });
    const verification = await verify(format, outputPath, { title, content });
    if (!verification.ok) {
      const failedChecks = verification.checks
        .filter((c) => !c.ok)
        .map((c) => `${c.name}: ${c.detail}`);
      const failed = await finishExport(exportId, {
        status: 'failed',
        verification: verification as unknown as Prisma.InputJsonValue,
        error: `La verificación del renderizado falló — ${failedChecks.join(' | ')}`.slice(0, 2000),
      });
      await notify(failed);
      return toDTO(failed, title);
    }
    const protectedDoc = row.document.status === 'approved' || row.document.status === 'shared';
    const object = await saveGeneratedFile({
      createdBy: row.createdBy,
      purpose: 'document',
      fileName,
      mimeType: EXPORT_FORMAT_INFO[format].mimeType,
      source: { filePath: outputPath },
      retentionPolicy: protectedDoc ? 'protected' : 'default',
      metadata: {
        studioDocumentId: row.documentId,
        studioExportId: row.id,
        studioVersionId: row.versionId,
        format,
        pageCount: rendered.pageCount ?? null,
        sheetNames: rendered.sheetNames ?? null,
        // HTML/SVG are delivered as downloads only (never rendered inline from storage).
        downloadOnly: format === 'html' || format === 'svg',
      },
    });
    const ready = await finishExport(exportId, {
      status: 'ready',
      storageObjectId: object.id,
      verification: verification as unknown as Prisma.InputJsonValue,
      error: null,
    });
    await notify(ready);
    return toDTO(ready, title);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = await finishExport(exportId, {
      status: 'failed',
      error: message.slice(0, 2000),
    });
    await notify(failed);
    return toDTO(failed, title);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
