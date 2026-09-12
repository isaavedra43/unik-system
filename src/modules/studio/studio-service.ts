import {
  Prisma,
  type StudioDocument,
  type StudioDocumentVersion,
  type StudioTemplate,
} from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { getStorageObject } from '@/modules/storage/storage-service';
import {
  contentFromTable,
  diffContent,
  emptyContent,
  hashContent,
  parseStudioContent,
  studioContentSchema,
  type ContentDiff,
  type StudioContent,
} from './studio-content';

/**
 * Studio service: documents, versions, templates, approval and sharing.
 *
 * Authorization is decided here (deny by default) and never in the client:
 * - owner → everything on their document;
 * - `studio.use` + visibility "team" → view and edit (collaboration);
 * - `studio.approve` → approve a version and share it with the team.
 *
 * Every save creates a NEW StudioDocumentVersion (never overwritten). When the
 * content of an approved/shared document changes, the document goes back to
 * `draft`, the approved version pointer is cleared and every pending AI
 * proposal bound to the document (or its exports) is invalidated — an approval
 * never silently applies to content nobody reviewed.
 */

export type StudioErrorCode = 'not_found' | 'forbidden' | 'invalid' | 'state';

export class StudioError extends Error {
  constructor(
    message: string,
    public readonly code: StudioErrorCode,
    public readonly status: number
  ) {
    super(message);
    this.name = 'StudioError';
  }
}

export const STUDIO_DOCUMENT_KINDS = ['document', 'spreadsheet', 'presentation', 'image'] as const;
export type StudioDocumentKind = (typeof STUDIO_DOCUMENT_KINDS)[number];
export const STUDIO_VISIBILITIES = ['private', 'team'] as const;
export const STUDIO_TEMPLATE_SCOPES = ['personal', 'team'] as const;

export const createDocumentSchema = z.object({
  title: z.string().trim().min(1, 'El título es obligatorio').max(200),
  kind: z.enum(STUDIO_DOCUMENT_KINDS).default('document'),
  content: studioContentSchema.optional(),
  templateId: z.string().min(1).max(64).optional(),
  artifactId: z.string().min(1).max(64).optional(),
  conversationId: z.string().min(1).max(64).optional(),
});
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

export const saveDocumentSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    content: studioContentSchema.optional(),
    changeSummary: z.string().trim().max(500).optional(),
    /** Image documents: the (edited) binary of this version. */
    storageObjectId: z.string().min(1).max(64).nullable().optional(),
  })
  .refine(
    (v) => v.title !== undefined || v.content !== undefined || v.storageObjectId !== undefined,
    {
      message: 'Nada que guardar',
    }
  );
export type SaveDocumentInput = z.infer<typeof saveDocumentSchema>;

export const templateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  kind: z.enum(STUDIO_DOCUMENT_KINDS).default('document'),
  scope: z.enum(STUDIO_TEMPLATE_SCOPES).default('personal'),
  content: studioContentSchema,
});
export type TemplateInput = z.infer<typeof templateSchema>;

export interface StudioPermissionsDTO {
  isOwner: boolean;
  canEdit: boolean;
  canApprove: boolean;
}

export interface StudioDocumentSummaryDTO {
  id: string;
  title: string;
  kind: string;
  status: string;
  visibility: string;
  ownerUserId: string;
  ownerName: string | null;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  currentVersion: number | null;
  conversationId: string | null;
  templateId: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  sharedAt: string | null;
  permissions: StudioPermissionsDTO;
}

export interface StudioDocumentDetailDTO extends StudioDocumentSummaryDTO {
  content: StudioContent;
  contentHash: string | null;
  storageObjectId: string | null;
  versionCount: number;
}

export interface StudioVersionDTO {
  id: string;
  version: number;
  contentHash: string;
  changeSummary: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  storageObjectId: string | null;
  isCurrent: boolean;
  isApproved: boolean;
}

export interface StudioTemplateDTO {
  id: string;
  name: string;
  kind: string;
  description: string | null;
  scope: string;
  ownerUserId: string;
  ownerName: string | null;
  status: string;
  blockCount: number;
  createdAt: string;
  updatedAt: string;
  content?: StudioContent;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

export function assertStudioUser(actor: CurrentUser): void {
  if (!hasPermission(actor, 'studio.use')) {
    throw new StudioError('Sin permiso para usar el estudio', 'forbidden', 403);
  }
}

export function canViewDocument(
  actor: CurrentUser,
  doc: Pick<StudioDocument, 'ownerUserId' | 'visibility'>
): boolean {
  if (!hasPermission(actor, 'studio.use')) return false;
  if (actor.isSuperAdmin || doc.ownerUserId === actor.id) return true;
  return doc.visibility === 'team';
}

export function canEditDocument(
  actor: CurrentUser,
  doc: Pick<StudioDocument, 'ownerUserId' | 'visibility' | 'status'>
): boolean {
  if (doc.status === 'archived') return false;
  return canViewDocument(actor, doc);
}

export function canApproveDocument(
  actor: CurrentUser,
  doc: Pick<StudioDocument, 'ownerUserId' | 'visibility' | 'status'>
): boolean {
  return canViewDocument(actor, doc) && hasPermission(actor, 'studio.approve');
}

function permissionsFor(actor: CurrentUser, doc: StudioDocument): StudioPermissionsDTO {
  return {
    isOwner: doc.ownerUserId === actor.id,
    canEdit: canEditDocument(actor, doc),
    canApprove: canApproveDocument(actor, doc),
  };
}

async function loadDocument(
  actor: CurrentUser,
  id: string,
  mode: 'view' | 'edit' | 'approve'
): Promise<StudioDocument> {
  assertStudioUser(actor);
  const doc = await prisma.studioDocument.findUnique({ where: { id } });
  if (!doc || !canViewDocument(actor, doc)) {
    throw new StudioError('Documento no encontrado', 'not_found', 404);
  }
  if (mode === 'edit' && !canEditDocument(actor, doc)) {
    throw new StudioError(
      doc.status === 'archived'
        ? 'El documento está archivado'
        : 'Sin permiso para editar este documento',
      'forbidden',
      403
    );
  }
  if (mode === 'approve' && !canApproveDocument(actor, doc)) {
    throw new StudioError('Se requiere el permiso de aprobación del estudio', 'forbidden', 403);
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function userNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, u.name]));
}

function toSummary(
  actor: CurrentUser,
  doc: StudioDocument,
  currentVersion: number | null,
  names: Map<string, string>
): StudioDocumentSummaryDTO {
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind,
    status: doc.status,
    visibility: doc.visibility,
    ownerUserId: doc.ownerUserId,
    ownerName: names.get(doc.ownerUserId) ?? null,
    currentVersionId: doc.currentVersionId,
    approvedVersionId: doc.approvedVersionId,
    currentVersion,
    conversationId: doc.conversationId,
    templateId: doc.templateId,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    approvedAt: doc.approvedAt?.toISOString() ?? null,
    sharedAt: doc.sharedAt?.toISOString() ?? null,
    permissions: permissionsFor(actor, doc),
  };
}

async function toDetail(actor: CurrentUser, doc: StudioDocument): Promise<StudioDocumentDetailDTO> {
  const [current, versionCount, names] = await Promise.all([
    doc.currentVersionId
      ? prisma.studioDocumentVersion.findUnique({ where: { id: doc.currentVersionId } })
      : Promise.resolve(null),
    prisma.studioDocumentVersion.count({ where: { documentId: doc.id } }),
    userNames([doc.ownerUserId]),
  ]);
  const content = current ? parseStudioContent(current.content) : emptyContent();
  return {
    ...toSummary(actor, doc, current?.version ?? null, names),
    content,
    contentHash: current?.contentHash ?? null,
    storageObjectId: current?.storageObjectId ?? null,
    versionCount,
  };
}

function toVersionDTO(
  v: StudioDocumentVersion,
  doc: StudioDocument,
  names: Map<string, string>
): StudioVersionDTO {
  return {
    id: v.id,
    version: v.version,
    contentHash: v.contentHash,
    changeSummary: v.changeSummary,
    createdBy: v.createdBy,
    createdByName: names.get(v.createdBy) ?? null,
    createdAt: v.createdAt.toISOString(),
    storageObjectId: v.storageObjectId,
    isCurrent: doc.currentVersionId === v.id,
    isApproved: doc.approvedVersionId === v.id,
  };
}

function toTemplateDTO(
  t: StudioTemplate,
  names: Map<string, string>,
  withContent: boolean
): StudioTemplateDTO {
  const content = parseStudioContent(t.content);
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    description: t.description,
    scope: t.scope,
    ownerUserId: t.ownerUserId,
    ownerName: names.get(t.ownerUserId) ?? null,
    status: t.status,
    blockCount: content.blocks.length,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    ...(withContent ? { content } : {}),
  };
}

type Tx = Prisma.TransactionClient;

async function createVersionRow(
  tx: Tx,
  input: {
    documentId: string;
    content: StudioContent;
    createdBy: string;
    changeSummary: string | null;
    storageObjectId: string | null;
  }
): Promise<StudioDocumentVersion> {
  const last = await tx.studioDocumentVersion.findFirst({
    where: { documentId: input.documentId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  return tx.studioDocumentVersion.create({
    data: {
      documentId: input.documentId,
      version: (last?.version ?? 0) + 1,
      content: input.content as unknown as Prisma.InputJsonValue,
      contentHash: hashContent(input.content),
      createdBy: input.createdBy,
      changeSummary: input.changeSummary,
      storageObjectId: input.storageObjectId,
    },
  });
}

/**
 * Image objects referenced by a version must be ready "document" objects that
 * were uploaded by the actor (through the `studio_document` target) or were
 * already part of the previous version — nobody can attach someone else's file
 * by guessing an id.
 */
async function assertImageObjectsAllowed(
  actor: CurrentUser,
  content: StudioContent,
  previous: StudioContent | null,
  extraObjectId: string | null
): Promise<void> {
  const previousIds = new Set<string>();
  for (const block of previous?.blocks ?? []) {
    if (block.type === 'image') previousIds.add(block.storageObjectId);
  }
  const ids = new Set<string>();
  for (const block of content.blocks) {
    if (block.type === 'image') ids.add(block.storageObjectId);
  }
  if (extraObjectId) ids.add(extraObjectId);
  for (const id of ids) {
    if (previousIds.has(id)) continue;
    const object = await getStorageObject(id);
    if (!object || object.status !== 'ready' || object.purpose !== 'document') {
      throw new StudioError(`La imagen ${id} no está disponible`, 'invalid', 400);
    }
    if (object.createdBy !== actor.id && !actor.isSuperAdmin) {
      throw new StudioError('No puedes usar una imagen que no subiste', 'forbidden', 403);
    }
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export async function listDocuments(
  actor: CurrentUser,
  options: { scope?: 'mine' | 'team'; includeArchived?: boolean } = {}
): Promise<StudioDocumentSummaryDTO[]> {
  assertStudioUser(actor);
  const scope = options.scope ?? 'mine';
  const where: Prisma.StudioDocumentWhereInput =
    scope === 'mine'
      ? { ownerUserId: actor.id }
      : actor.isSuperAdmin
        ? { ownerUserId: { not: actor.id } }
        : { visibility: 'team', ownerUserId: { not: actor.id } };
  if (!options.includeArchived) where.status = { not: 'archived' };
  const docs = await prisma.studioDocument.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });
  const versionIds = docs.map((d) => d.currentVersionId).filter((v): v is string => Boolean(v));
  const [versions, names] = await Promise.all([
    versionIds.length > 0
      ? prisma.studioDocumentVersion.findMany({
          where: { id: { in: versionIds } },
          select: { id: true, version: true },
        })
      : Promise.resolve([]),
    userNames(docs.map((d) => d.ownerUserId)),
  ]);
  const versionNumbers = new Map(versions.map((v) => [v.id, v.version]));
  return docs.map((doc) =>
    toSummary(
      actor,
      doc,
      doc.currentVersionId ? (versionNumbers.get(doc.currentVersionId) ?? null) : null,
      names
    )
  );
}

export async function getDocument(
  actor: CurrentUser,
  id: string
): Promise<StudioDocumentDetailDTO> {
  const doc = await loadDocument(actor, id, 'view');
  return toDetail(actor, doc);
}

async function contentFromArtifact(
  actor: CurrentUser,
  artifactId: string
): Promise<{ content: StudioContent; conversationId: string; title: string | null }> {
  const artifact = await prisma.aiArtifact.findUnique({
    where: { id: artifactId },
    include: { conversation: { select: { userId: true } } },
  });
  if (!artifact || (artifact.conversation.userId !== actor.id && !actor.isSuperAdmin)) {
    throw new StudioError('Artefacto no encontrado', 'not_found', 404);
  }
  const data = (artifact.inlineData ?? {}) as Record<string, unknown>;
  const meta = (artifact.meta ?? {}) as Record<string, unknown>;
  const columns = Array.isArray(data.columns)
    ? (data.columns as Array<Record<string, unknown>>)
    : null;
  const rows = Array.isArray(data.rows) ? (data.rows as Array<Record<string, unknown>>) : null;
  if (!columns || !rows) {
    throw new StudioError(
      'Solo se pueden importar artefactos con tabla (columnas y filas)',
      'invalid',
      400
    );
  }
  const title =
    typeof data.title === 'string'
      ? data.title
      : typeof meta.title === 'string'
        ? meta.title
        : null;
  const summary = Array.isArray(data.summary)
    ? (data.summary as Array<Record<string, unknown>>)
        .filter((s) => typeof s.label === 'string')
        .map((s) => ({ label: String(s.label), value: String(s.value ?? '') }))
    : undefined;
  const content = contentFromTable({
    title: title ?? undefined,
    columns: columns
      .filter((c) => typeof c.key === 'string')
      .map((c) => ({
        key: String(c.key),
        header: typeof c.header === 'string' ? c.header : String(c.key),
        format:
          c.format === 'currency' ||
          c.format === 'number' ||
          c.format === 'percentage' ||
          c.format === 'date' ||
          c.format === 'text'
            ? c.format
            : undefined,
      })),
    rows,
    summary,
  });
  return { content, conversationId: artifact.conversationId, title };
}

export async function createDocument(
  actor: CurrentUser,
  rawInput: CreateDocumentInput
): Promise<StudioDocumentDetailDTO> {
  assertStudioUser(actor);
  const input = createDocumentSchema.parse(rawInput);
  let content: StudioContent = input.content ?? emptyContent();
  let conversationId = input.conversationId ?? null;
  let changeSummary = 'Documento creado';
  let templateId: string | null = null;

  if (input.templateId) {
    const template = await loadTemplate(actor, input.templateId);
    content = parseStudioContent(template.content);
    templateId = template.id;
    changeSummary = `Creado desde la plantilla "${template.name}"`;
  } else if (input.artifactId) {
    const imported = await contentFromArtifact(actor, input.artifactId);
    content = imported.content;
    conversationId = imported.conversationId;
    changeSummary = 'Importado desde un artefacto del asistente';
  }
  await assertImageObjectsAllowed(actor, content, null, null);

  const doc = await prisma.$transaction(async (tx) => {
    const created = await tx.studioDocument.create({
      data: {
        ownerUserId: actor.id,
        title: input.title,
        kind: input.kind,
        status: 'draft',
        visibility: 'private',
        templateId,
        conversationId,
      },
    });
    const version = await createVersionRow(tx, {
      documentId: created.id,
      content,
      createdBy: actor.id,
      changeSummary,
      storageObjectId: null,
    });
    return tx.studioDocument.update({
      where: { id: created.id },
      data: { currentVersionId: version.id },
    });
  });
  return toDetail(actor, doc);
}

export interface SaveDocumentResult {
  document: StudioDocumentDetailDTO;
  versionCreated: boolean;
  version: number | null;
  diff: ContentDiff | null;
  revertedToDraft: boolean;
  invalidatedProposals: number;
}

export async function saveDocument(
  actor: CurrentUser,
  id: string,
  rawInput: SaveDocumentInput
): Promise<SaveDocumentResult> {
  const input = saveDocumentSchema.parse(rawInput);
  const doc = await loadDocument(actor, id, 'edit');
  const current = doc.currentVersionId
    ? await prisma.studioDocumentVersion.findUnique({ where: { id: doc.currentVersionId } })
    : null;
  const previousContent = current ? parseStudioContent(current.content) : emptyContent();
  const nextContent = input.content ?? previousContent;
  const nextObjectId =
    input.storageObjectId === undefined
      ? (current?.storageObjectId ?? null)
      : input.storageObjectId;
  await assertImageObjectsAllowed(actor, nextContent, previousContent, nextObjectId);

  const contentChanged =
    hashContent(nextContent) !== (current?.contentHash ?? '') ||
    nextObjectId !== (current?.storageObjectId ?? null);
  const diff = input.content ? diffContent(previousContent, nextContent) : null;
  const wasApproved = doc.status === 'approved' || doc.status === 'shared';
  const revertedToDraft = contentChanged && wasApproved;

  const updated = await prisma.$transaction(async (tx) => {
    const data: Prisma.StudioDocumentUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (contentChanged) {
      const version = await createVersionRow(tx, {
        documentId: doc.id,
        content: nextContent,
        createdBy: actor.id,
        changeSummary: input.changeSummary ?? diff?.summary ?? 'Versión guardada',
        storageObjectId: nextObjectId,
      });
      data.currentVersionId = version.id;
      if (wasApproved) {
        data.status = 'draft';
        data.approvedVersionId = null;
        data.approvedBy = null;
        data.approvedAt = null;
        data.sharedAt = null;
      }
    }
    return tx.studioDocument.update({ where: { id: doc.id }, data });
  });

  let invalidated = 0;
  if (revertedToDraft) {
    invalidated = await invalidateProposalsForDocument(doc.id);
    await recordAuditEvent({
      actorUserId: actor.id,
      action: 'studio.document.reverted_to_draft',
      targetType: 'StudioDocument',
      targetId: doc.id,
      metadata: { invalidatedProposals: invalidated },
    });
  }
  const detail = await toDetail(actor, updated);
  return {
    document: detail,
    versionCreated: contentChanged,
    version: detail.currentVersion,
    diff,
    revertedToDraft,
    invalidatedProposals: invalidated,
  };
}

export async function listVersions(actor: CurrentUser, id: string): Promise<StudioVersionDTO[]> {
  const doc = await loadDocument(actor, id, 'view');
  const versions = await prisma.studioDocumentVersion.findMany({
    where: { documentId: id },
    orderBy: { version: 'desc' },
    select: {
      id: true,
      documentId: true,
      version: true,
      contentHash: true,
      changeSummary: true,
      createdBy: true,
      createdAt: true,
      storageObjectId: true,
    },
  });
  const names = await userNames(versions.map((v) => v.createdBy));
  return versions.map((v) =>
    toVersionDTO({ ...v, content: Prisma.JsonNull } as unknown as StudioDocumentVersion, doc, names)
  );
}

export async function getVersion(
  actor: CurrentUser,
  id: string,
  versionId: string
): Promise<StudioVersionDTO & { content: StudioContent }> {
  const doc = await loadDocument(actor, id, 'view');
  const version = await prisma.studioDocumentVersion.findFirst({
    where: { id: versionId, documentId: id },
  });
  if (!version) throw new StudioError('Versión no encontrada', 'not_found', 404);
  const names = await userNames([version.createdBy]);
  return { ...toVersionDTO(version, doc, names), content: parseStudioContent(version.content) };
}

/** Restoring never rewinds history: the restored content becomes a NEW version. */
export async function restoreVersion(
  actor: CurrentUser,
  id: string,
  versionId: string
): Promise<SaveDocumentResult> {
  await loadDocument(actor, id, 'edit');
  const version = await prisma.studioDocumentVersion.findFirst({
    where: { id: versionId, documentId: id },
  });
  if (!version) throw new StudioError('Versión no encontrada', 'not_found', 404);
  return saveDocument(actor, id, {
    content: parseStudioContent(version.content),
    storageObjectId: version.storageObjectId,
    changeSummary: `Restaurada la versión ${version.version}`,
  });
}

export async function archiveDocument(
  actor: CurrentUser,
  id: string
): Promise<StudioDocumentSummaryDTO> {
  const doc = await loadDocument(actor, id, 'view');
  if (
    doc.ownerUserId !== actor.id &&
    !actor.isSuperAdmin &&
    !hasPermission(actor, 'studio.approve')
  ) {
    throw new StudioError('Solo el propietario puede archivar el documento', 'forbidden', 403);
  }
  const updated = await prisma.studioDocument.update({
    where: { id },
    data: { status: 'archived' },
  });
  await invalidateProposalsForDocument(id);
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'studio.document.archived',
    targetType: 'StudioDocument',
    targetId: id,
  });
  return toSummary(actor, updated, null, await userNames([updated.ownerUserId]));
}

export async function approveDocument(
  actor: CurrentUser,
  id: string
): Promise<StudioDocumentDetailDTO> {
  const doc = await loadDocument(actor, id, 'approve');
  if (doc.status === 'archived') throw new StudioError('El documento está archivado', 'state', 409);
  if (!doc.currentVersionId) throw new StudioError('El documento no tiene contenido', 'state', 409);
  const updated = await prisma.studioDocument.update({
    where: { id },
    data: {
      status: doc.status === 'shared' ? 'shared' : 'approved',
      approvedVersionId: doc.currentVersionId,
      approvedBy: actor.id,
      approvedAt: new Date(),
    },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'studio.document.approved',
    targetType: 'StudioDocument',
    targetId: id,
    metadata: { versionId: doc.currentVersionId },
  });
  return toDetail(actor, updated);
}

/** Sharing publishes the APPROVED version to everyone with `studio.use`. */
export async function shareDocument(
  actor: CurrentUser,
  id: string
): Promise<StudioDocumentDetailDTO> {
  const doc = await loadDocument(actor, id, 'approve');
  if (doc.status !== 'approved' && doc.status !== 'shared') {
    throw new StudioError('Solo se puede compartir un documento aprobado', 'state', 409);
  }
  if (!doc.approvedVersionId || doc.approvedVersionId !== doc.currentVersionId) {
    throw new StudioError('La versión actual no es la aprobada', 'state', 409);
  }
  const updated = await prisma.studioDocument.update({
    where: { id },
    data: { status: 'shared', visibility: 'team', sharedAt: new Date() },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'studio.document.shared',
    targetType: 'StudioDocument',
    targetId: id,
    metadata: { versionId: doc.approvedVersionId },
  });
  return toDetail(actor, updated);
}

/**
 * Pending AI proposals bound (through `fileIds`) to the document, its exports
 * or the files of those exports are invalidated: the content they were
 * approved against no longer exists.
 */
export async function invalidateProposalsForDocument(documentId: string): Promise<number> {
  const exports = await prisma.studioExport.findMany({
    where: { documentId },
    select: { id: true, storageObjectId: true },
  });
  const ids = [
    documentId,
    ...exports.map((e) => e.id),
    ...exports.map((e) => e.storageObjectId).filter((v): v is string => Boolean(v)),
  ];
  const res = await prisma.aiProposal.updateMany({
    where: { status: 'pending', fileIds: { hasSome: ids } },
    data: { status: 'invalidated', error: 'El documento cambió' },
  });
  return res.count;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function canUseTemplate(actor: CurrentUser, template: StudioTemplate): boolean {
  if (template.status === 'archived') return false;
  if (actor.isSuperAdmin || template.ownerUserId === actor.id) return true;
  return template.scope === 'team' && template.status === 'published';
}

function canManageTemplate(actor: CurrentUser, template: StudioTemplate): boolean {
  if (actor.isSuperAdmin || template.ownerUserId === actor.id) return true;
  return template.scope === 'team' && hasPermission(actor, 'studio.approve');
}

async function loadTemplate(actor: CurrentUser, id: string): Promise<StudioTemplate> {
  assertStudioUser(actor);
  const template = await prisma.studioTemplate.findUnique({ where: { id } });
  if (!template || !canUseTemplate(actor, template)) {
    throw new StudioError('Plantilla no encontrada', 'not_found', 404);
  }
  return template;
}

export async function listTemplates(actor: CurrentUser): Promise<StudioTemplateDTO[]> {
  assertStudioUser(actor);
  const templates = await prisma.studioTemplate.findMany({
    where: {
      status: { not: 'archived' },
      ...(actor.isSuperAdmin
        ? {}
        : { OR: [{ ownerUserId: actor.id }, { scope: 'team', status: 'published' }] }),
    },
    orderBy: [{ scope: 'asc' }, { updatedAt: 'desc' }],
    take: 200,
  });
  const names = await userNames(templates.map((t) => t.ownerUserId));
  return templates.map((t) => toTemplateDTO(t, names, false));
}

export async function getTemplate(actor: CurrentUser, id: string): Promise<StudioTemplateDTO> {
  const template = await loadTemplate(actor, id);
  return toTemplateDTO(template, await userNames([template.ownerUserId]), true);
}

export async function createTemplate(
  actor: CurrentUser,
  rawInput: TemplateInput
): Promise<StudioTemplateDTO> {
  assertStudioUser(actor);
  const input = templateSchema.parse(rawInput);
  if (input.scope === 'team' && !hasPermission(actor, 'studio.approve')) {
    throw new StudioError(
      'Las plantillas de equipo requieren el permiso de aprobación',
      'forbidden',
      403
    );
  }
  await assertImageObjectsAllowed(actor, input.content, null, null);
  const template = await prisma.studioTemplate.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      kind: input.kind,
      scope: input.scope,
      content: input.content as unknown as Prisma.InputJsonValue,
      ownerUserId: actor.id,
      status: 'published',
    },
  });
  if (input.scope === 'team') {
    await recordAuditEvent({
      actorUserId: actor.id,
      action: 'studio.template.created',
      targetType: 'StudioTemplate',
      targetId: template.id,
      metadata: { scope: 'team' },
    });
  }
  return toTemplateDTO(template, await userNames([actor.id]), true);
}

export async function updateTemplate(
  actor: CurrentUser,
  id: string,
  rawInput: Partial<TemplateInput>
): Promise<StudioTemplateDTO> {
  assertStudioUser(actor);
  const input = templateSchema.partial().parse(rawInput);
  const template = await prisma.studioTemplate.findUnique({ where: { id } });
  if (!template || template.status === 'archived' || !canManageTemplate(actor, template)) {
    throw new StudioError('Plantilla no encontrada', 'not_found', 404);
  }
  if (
    input.scope === 'team' &&
    template.scope !== 'team' &&
    !hasPermission(actor, 'studio.approve')
  ) {
    throw new StudioError(
      'Las plantillas de equipo requieren el permiso de aprobación',
      'forbidden',
      403
    );
  }
  if (input.content)
    await assertImageObjectsAllowed(
      actor,
      input.content,
      parseStudioContent(template.content),
      null
    );
  const updated = await prisma.studioTemplate.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.content !== undefined
        ? { content: input.content as unknown as Prisma.InputJsonValue }
        : {}),
    },
  });
  return toTemplateDTO(updated, await userNames([updated.ownerUserId]), true);
}

export async function deleteTemplate(actor: CurrentUser, id: string): Promise<void> {
  assertStudioUser(actor);
  const template = await prisma.studioTemplate.findUnique({ where: { id } });
  if (!template || template.status === 'archived' || !canManageTemplate(actor, template)) {
    throw new StudioError('Plantilla no encontrada', 'not_found', 404);
  }
  await prisma.studioTemplate.update({ where: { id }, data: { status: 'archived' } });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'studio.template.archived',
    targetType: 'StudioTemplate',
    targetId: id,
  });
}
