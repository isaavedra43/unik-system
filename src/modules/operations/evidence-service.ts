import { randomUUID } from 'crypto';
import type { EvidenceLink, Prisma, StorageObject, WorkItem } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import {
  executeCommand,
  registerCommand,
  requireCommandContext,
  type CommandContext,
  type CommandResult,
} from './commands';
import { authorizeOperationsChannel } from './events-service';
import { OperationsError } from './errors';
import {
  STRUCTURED_EVIDENCE_LABELS,
  EVIDENCE_KINDS,
  WORK_ITEM_OPEN_STATUSES,
  type ActorType,
  type EvidenceKind,
} from './types';

/**
 * Evidence of operational work (plan section 2.1, `EvidenceLink`).
 *
 * An evidence row links a photo, signature, document, note, count or Zoho
 * read-back to a work item, a case step or any operational object (delivery
 * order, goods receipt, case...). Files live in `StorageObject` with purpose
 * `evidence` (uploaded through the `operations_evidence` target registered in
 * `operations-storage.ts`); notes and structured counts may have no file.
 *
 * - `evidence.attach` command: the owner/backup of the work item (or of a work
 *   item on the same step/object), the case owner, `operations.manage` or a
 *   system actor may attach. Attaching the same file twice to the same target
 *   returns the existing row.
 * - `attachEvidenceInTx(tx, input)` for other modules' commands, which already
 *   checked their own permissions.
 * - `missingEvidence` (pure) decides whether a work item's `requiredEvidence`
 *   is satisfied when it is completed.
 */

export const EVIDENCE_ATTACH_COMMAND = 'evidence.attach';

/** Module event (valid `<group>.<fact>` type; not part of the core OPS_EVENTS yet). */
export const EVIDENCE_EVENTS = { attached: 'evidence.attached' } as const;

/** StorageObject.purpose of evidence files. */
export const EVIDENCE_STORAGE_PURPOSE = 'evidence';
export const EVIDENCE_MAX_BYTES = 15 * 1024 * 1024;

/** Image, PDF and audio (voice notes), as detected by the storage validator. */
export const EVIDENCE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/webm',
  'audio/webm;codecs=opus',
] as const;

export const EVIDENCE_KIND_LABELS: Record<EvidenceKind, string> = {
  photo: 'Foto',
  signature: 'Firma',
  document: 'Documento',
  note: 'Nota',
  count: 'Conteo',
  zoho_readback: 'Confirmación de Zoho',
};

/** Kinds that only make sense with a file. */
const FILE_EVIDENCE_KINDS: readonly EvidenceKind[] = ['photo', 'signature', 'document'];

/** Upload states in which a file can still be referenced (the reference is created at initiation). */
const USABLE_STORAGE_STATUSES = ['initiated', 'uploading', 'validating', 'ready'];

const OBJECT_TYPE_PATTERN = /^[a-z][a-z0-9_]{1,59}$/;
const MAX_ID_LENGTH = 120;

type Db = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return typeof value === 'string' && (EVIDENCE_KINDS as readonly string[]).includes(value);
}

function baseMime(mimeType: string): string {
  return String(mimeType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/** Whether a file of `mimeType` can be evidence of `kind`. */
export function evidenceKindAcceptsMime(kind: EvidenceKind, mimeType: string): boolean {
  const mime = baseMime(mimeType);
  const image = mime.startsWith('image/') && mime !== 'image/svg+xml';
  const pdf = mime === 'application/pdf';
  const audio = mime.startsWith('audio/');
  switch (kind) {
    case 'photo':
    case 'signature':
      return image;
    case 'document':
      return pdf || image;
    case 'note':
      return audio;
    case 'count':
    case 'zoho_readback':
      return image || pdf;
    default:
      return false;
  }
}

/** Kind inferred from the file when the uploader does not say it: image → photo, PDF → document, audio → note. */
export function defaultEvidenceKindForMime(mimeType: string): EvidenceKind | null {
  const mime = baseMime(mimeType);
  if (mime === 'application/pdf') return 'document';
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'photo';
  if (mime.startsWith('audio/')) return 'note';
  return null;
}

/** Spanish label of a required evidence key (kinds have labels; structured keys are humanized). */
export function describeEvidenceKey(key: string): string {
  if (isEvidenceKind(key)) return EVIDENCE_KIND_LABELS[key];
  return STRUCTURED_EVIDENCE_LABELS[key] ?? key.replace(/_/g, ' ');
}

/** Keys of a completion result whose value counts as provided (not null, empty string or empty list). */
export function presentResultKeys(result: Record<string, unknown> | null | undefined): string[] {
  if (!result) return [];
  return Object.entries(result)
    .filter(([, value]) => {
      if (value === null || value === undefined) return false;
      if (typeof value === 'string') return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    })
    .map(([key]) => key);
}

/**
 * Required evidence still missing. File kinds (photo, signature, document)
 * need an `EvidenceLink` of that kind; note, count and zoho_readback accept a
 * link or a structured result key with the same name; any other key (e.g.
 * `availability_result`, `delivery_order`) must be a structured result key.
 */
export function missingEvidence(
  required: readonly string[],
  provided: { kinds: readonly string[]; keys: readonly string[] }
): string[] {
  const kinds = new Set(provided.kinds);
  const keys = new Set(provided.keys);
  const missing: string[] = [];
  for (const raw of required) {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!key || missing.includes(key)) continue;
    let satisfied: boolean;
    if (isEvidenceKind(key)) {
      satisfied = FILE_EVIDENCE_KINDS.includes(key)
        ? kinds.has(key)
        : kinds.has(key) || keys.has(key);
    } else {
      satisfied = keys.has(key);
    }
    if (!satisfied) missing.push(key);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export type EvidenceTarget =
  | { workItemId: string }
  | { stepId: string }
  | { objectType: string; objectId: string; caseId?: string | null };

/**
 * Upload target ids of `operations_evidence`: `work_item:<id>`,
 * `case_step:<id>` or `<objectType>:<objectId>`, with an optional `#<kind>`
 * suffix (e.g. `delivery_order:ck123#signature`). Returns null when invalid.
 */
export function parseEvidenceTargetId(
  targetId: string
): { target: EvidenceTarget; kind: EvidenceKind | null } | null {
  const value = typeof targetId === 'string' ? targetId.trim() : '';
  if (!value || value.length > 200) return null;
  let body = value;
  let kind: EvidenceKind | null = null;
  const hash = value.lastIndexOf('#');
  if (hash >= 0) {
    const suffix = value.slice(hash + 1);
    if (!isEvidenceKind(suffix)) return null;
    kind = suffix;
    body = value.slice(0, hash);
  }
  const separator = body.indexOf(':');
  if (separator <= 0) return null;
  const type = body.slice(0, separator);
  const id = body.slice(separator + 1).trim();
  if (!id || id.length > MAX_ID_LENGTH || !OBJECT_TYPE_PATTERN.test(type)) return null;
  if (type === 'work_item') return { target: { workItemId: id }, kind };
  if (type === 'case_step') return { target: { stepId: id }, kind };
  return { target: { objectType: type, objectId: id }, kind };
}

export function formatEvidenceTargetId(target: EvidenceTarget, kind?: EvidenceKind | null): string {
  const base =
    'workItemId' in target
      ? `work_item:${target.workItemId}`
      : 'stepId' in target
        ? `case_step:${target.stepId}`
        : `${target.objectType}:${target.objectId}`;
  return kind ? `${base}#${kind}` : base;
}

type WorkItemRef = Pick<
  WorkItem,
  | 'id'
  | 'ownerUserId'
  | 'backupUserId'
  | 'caseId'
  | 'stepId'
  | 'areaKey'
  | 'objectType'
  | 'objectId'
>;

export interface ResolvedEvidenceTarget {
  caseId: string | null;
  workItemId: string | null;
  stepId: string | null;
  objectType: string;
  objectId: string;
  areaKey: string | null;
  workItem: WorkItemRef | null;
}

export interface EvidenceTargetInput {
  workItemId?: string | null;
  stepId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  caseId?: string | null;
}

const WORK_ITEM_REF_SELECT = {
  id: true,
  ownerUserId: true,
  backupUserId: true,
  caseId: true,
  stepId: true,
  areaKey: true,
  objectType: true,
  objectId: true,
} as const;

/** Loads and normalizes the target (work item → its step/object/case; step → its case). */
export async function resolveEvidenceTarget(
  db: Db,
  input: EvidenceTargetInput
): Promise<ResolvedEvidenceTarget> {
  const explicitObject =
    input.objectType && input.objectId
      ? { objectType: input.objectType, objectId: input.objectId }
      : null;
  if (input.objectType && !OBJECT_TYPE_PATTERN.test(input.objectType)) {
    throw new OperationsError('invalid_payload', 'Tipo de objeto inválido');
  }

  if (input.workItemId) {
    const item = await db.workItem.findUnique({
      where: { id: input.workItemId },
      select: WORK_ITEM_REF_SELECT,
    });
    if (!item) throw new OperationsError('not_found', 'No se encontró el trabajo');
    const own =
      item.objectType && item.objectId
        ? { objectType: item.objectType, objectId: item.objectId }
        : { objectType: 'work_item', objectId: item.id };
    // Participation is checked on the work item: its evidence can only be linked to
    // its own record, never to another object (someone else's request or delivery).
    if (
      explicitObject &&
      (explicitObject.objectType !== own.objectType || explicitObject.objectId !== own.objectId)
    ) {
      throw new OperationsError(
        'invalid_payload',
        'La evidencia de un trabajo se liga a su propio registro; no indiques otro'
      );
    }
    const object = own;
    return {
      caseId: item.caseId,
      workItemId: item.id,
      stepId: item.stepId,
      ...object,
      areaKey: item.areaKey,
      workItem: item,
    };
  }

  if (input.stepId) {
    const step = await db.caseStep.findUnique({
      where: { id: input.stepId },
      select: { id: true, caseId: true, areaKey: true },
    });
    if (!step) throw new OperationsError('not_found', 'No se encontró el paso del expediente');
    if (
      explicitObject &&
      (explicitObject.objectType !== 'case_step' || explicitObject.objectId !== step.id)
    ) {
      throw new OperationsError(
        'invalid_payload',
        'La evidencia de un paso se liga al propio paso; no indiques otro registro'
      );
    }
    return {
      caseId: step.caseId,
      workItemId: null,
      stepId: step.id,
      objectType: 'case_step',
      objectId: step.id,
      areaKey: step.areaKey,
      workItem: null,
    };
  }

  if (!explicitObject) {
    throw new OperationsError(
      'invalid_payload',
      'Indica el trabajo, el paso o el registro de la evidencia'
    );
  }
  const caseId =
    input.caseId ??
    (explicitObject.objectType === 'operational_case' ? explicitObject.objectId : null);
  if (caseId) {
    const found = await db.operationalCase.findUnique({
      where: { id: caseId },
      select: { id: true },
    });
    if (!found) throw new OperationsError('not_found', 'No se encontró el expediente');
  }
  return {
    caseId,
    workItemId: null,
    stepId: null,
    ...explicitObject,
    areaKey: null,
    workItem: null,
  };
}

function isParticipant(
  userId: string,
  item: { ownerUserId: string; backupUserId: string | null }
): boolean {
  return item.ownerUserId === userId || item.backupUserId === userId;
}

/** Owner/backup of the target work item or of a work item on the same step/object, or the case owner. */
async function isEvidenceParticipant(
  db: Db,
  userId: string,
  target: ResolvedEvidenceTarget
): Promise<boolean> {
  if (target.workItem && isParticipant(userId, target.workItem)) return true;
  const related: Prisma.WorkItemWhereInput[] = [
    { objectType: target.objectType, objectId: target.objectId },
  ];
  if (target.stepId) related.push({ stepId: target.stepId });
  const item = await db.workItem.findFirst({
    where: {
      status: { in: [...WORK_ITEM_OPEN_STATUSES, 'done'] },
      OR: related,
      AND: [{ OR: [{ ownerUserId: userId }, { backupUserId: userId }] }],
    },
    select: { id: true },
  });
  if (item) return true;
  if (target.caseId) {
    const operationalCase = await db.operationalCase.findUnique({
      where: { id: target.caseId },
      select: { ownerUserId: true },
    });
    if (operationalCase?.ownerUserId === userId) return true;
  }
  return false;
}

/** System actors, `operations.manage` and the participants of the target may attach evidence. */
export async function canAttachEvidence(
  db: Db,
  user: CurrentUser | null,
  actorType: ActorType,
  target: ResolvedEvidenceTarget
): Promise<boolean> {
  if (actorType === 'system' || actorType === 'zoho') return true;
  if (!user) return false;
  if (hasPermission(user, 'operations.manage')) return true;
  return isEvidenceParticipant(db, user.id, target);
}

/**
 * Evidence that counts for a work item: linked to it, or to its step or object
 * after the work item was created (evidence of a previous attempt does not count).
 */
export function evidenceWhereForWorkItem(
  item: Pick<WorkItem, 'id' | 'stepId' | 'objectType' | 'objectId' | 'createdAt'>
): Prisma.EvidenceLinkWhereInput {
  const or: Prisma.EvidenceLinkWhereInput[] = [{ workItemId: item.id }];
  if (item.stepId) or.push({ stepId: item.stepId, createdAt: { gte: item.createdAt } });
  if (item.objectType && item.objectId) {
    or.push({
      objectType: item.objectType,
      objectId: item.objectId,
      createdAt: { gte: item.createdAt },
    });
  }
  return { OR: or };
}

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

const idField = z.string().trim().min(1).max(MAX_ID_LENGTH);

export const attachEvidenceSchema = z
  .object({
    workItemId: idField.optional(),
    stepId: idField.optional(),
    objectType: z.string().trim().regex(OBJECT_TYPE_PATTERN, 'Tipo de objeto inválido').optional(),
    objectId: idField.optional(),
    caseId: idField.optional(),
    kind: z.enum(EVIDENCE_KINDS),
    storageObjectId: idField.optional(),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.workItemId && !value.stepId && !(value.objectType && value.objectId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Indica el trabajo, el paso o el registro de la evidencia',
      });
    }
    if (Boolean(value.objectType) !== Boolean(value.objectId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['objectId'],
        message: 'El tipo y el identificador del registro van juntos',
      });
    }
    if (FILE_EVIDENCE_KINDS.includes(value.kind) && !value.storageObjectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['storageObjectId'],
        message: 'Esta evidencia necesita un archivo',
      });
    }
    if (!value.storageObjectId && !value.note) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: 'Agrega un archivo o una nota',
      });
    }
  });

export type AttachEvidenceInput = z.input<typeof attachEvidenceSchema>;
type ParsedAttach = z.output<typeof attachEvidenceSchema>;

export interface EvidenceAttachData {
  evidenceId: string;
  created: boolean;
  caseId: string | null;
  workItemId: string | null;
  stepId: string | null;
  objectType: string;
  objectId: string;
}

function parseAttach(input: AttachEvidenceInput): ParsedAttach {
  const parsed = attachEvidenceSchema.safeParse(input);
  if (!parsed.success) {
    throw new OperationsError(
      'invalid_payload',
      `Evidencia inválida: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) =>
          issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message
        )
        .join('; ')}`
    );
  }
  return parsed.data;
}

async function attachResolved(
  tx: Db,
  ctx: CommandContext,
  target: ResolvedEvidenceTarget,
  data: ParsedAttach
): Promise<{ evidence: EvidenceLink; created: boolean }> {
  if (data.storageObjectId) {
    const storage = await tx.storageObject.findUnique({ where: { id: data.storageObjectId } });
    if (!storage || storage.deletedAt) {
      throw new OperationsError('not_found', 'No se encontró el archivo de la evidencia');
    }
    if (storage.purpose !== EVIDENCE_STORAGE_PURPOSE) {
      throw new OperationsError('invalid_payload', 'El archivo no se subió como evidencia');
    }
    if (!USABLE_STORAGE_STATUSES.includes(storage.status)) {
      throw new OperationsError(
        'invalid_state',
        'El archivo fue rechazado o ya no está disponible'
      );
    }
    const personal = ctx.actor.type === 'user' || ctx.actor.type === 'ai';
    const manager = ctx.user ? hasPermission(ctx.user, 'operations.manage') : false;
    if (personal && storage.createdBy !== ctx.actor.id && !manager) {
      throw new OperationsError('forbidden', 'Sólo puedes adjuntar archivos que tú subiste');
    }
    const mime = storage.detectedMimeType ?? storage.declaredMimeType;
    if (!evidenceKindAcceptsMime(data.kind, mime)) {
      throw new OperationsError(
        'invalid_payload',
        `Un archivo ${baseMime(mime)} no sirve como ${EVIDENCE_KIND_LABELS[data.kind].toLowerCase()}`
      );
    }
    const existing = await tx.evidenceLink.findFirst({
      where: {
        storageObjectId: storage.id,
        objectType: target.objectType,
        objectId: target.objectId,
        workItemId: target.workItemId,
      },
    });
    if (existing) return { evidence: existing, created: false };
  }

  const evidence = await tx.evidenceLink.create({
    data: {
      caseId: target.caseId,
      workItemId: target.workItemId,
      stepId: target.stepId,
      objectType: target.objectType,
      objectId: target.objectId,
      kind: data.kind,
      storageObjectId: data.storageObjectId ?? null,
      note: data.note ?? null,
      createdBy: ctx.actor.id,
      createdAt: ctx.now,
    },
  });
  ctx.emit(
    EVIDENCE_EVENTS.attached,
    {
      evidenceId: evidence.id,
      kind: evidence.kind,
      storageObjectId: evidence.storageObjectId,
      workItemId: evidence.workItemId,
      stepId: evidence.stepId,
      hasNote: evidence.note !== null,
    },
    {
      caseId: target.caseId,
      areaKey: target.areaKey,
      objectType: target.objectType,
      objectId: target.objectId,
    }
  );
  return { evidence, created: true };
}

/**
 * Attaches evidence inside the caller's command (the caller already checked
 * its permissions). Same validations as `evidence.attach` except the actor check.
 */
export async function attachEvidenceInTx(
  tx: Db,
  input: AttachEvidenceInput
): Promise<{ evidence: EvidenceLink; created: boolean }> {
  const ctx = requireCommandContext(tx);
  const data = parseAttach(input);
  const target = await resolveEvidenceTarget(tx, data);
  return attachResolved(tx, ctx, target, data);
}

registerCommand<ParsedAttach, EvidenceAttachData>(EVIDENCE_ATTACH_COMMAND, {
  schema: attachEvidenceSchema,
  aggregate: 'none',
  async handler(tx, cmd, ctx) {
    const target = await resolveEvidenceTarget(tx, cmd.payload);
    if (!(await canAttachEvidence(tx, ctx.user, ctx.actor.type, target))) {
      throw new OperationsError(
        'forbidden',
        'Sólo el responsable del trabajo, su suplente o un gestor de operaciones puede adjuntar evidencia'
      );
    }
    const { evidence, created } = await attachResolved(tx, ctx, target, cmd.payload);
    return {
      data: {
        evidenceId: evidence.id,
        created,
        caseId: evidence.caseId,
        workItemId: evidence.workItemId,
        stepId: evidence.stepId,
        objectType: evidence.objectType,
        objectId: evidence.objectId,
      },
    };
  },
});

function evidenceAggregateId(input: AttachEvidenceInput): string {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const id = text(input.workItemId)
    ? `work_item:${text(input.workItemId)}`
    : text(input.stepId)
      ? `case_step:${text(input.stepId)}`
      : text(input.objectType) && text(input.objectId)
        ? `${text(input.objectType)}:${text(input.objectId)}`
        : 'unresolved';
  return id.slice(0, 200);
}

/** Runs `evidence.attach` for a signed-in user. Repeating `commandId` replays the result. */
export async function attachEvidence(
  actor: CurrentUser,
  input: AttachEvidenceInput,
  options: { commandId?: string; now?: Date; deviceId?: string } = {}
): Promise<CommandResult<EvidenceAttachData>> {
  return executeCommand<EvidenceAttachData>(
    {
      commandId: options.commandId ?? randomUUID(),
      type: EVIDENCE_ATTACH_COMMAND,
      actor: { type: 'user', id: actor.id },
      aggregate: { type: 'evidence_target', id: evidenceAggregateId(input) },
      payload: input,
      deviceId: options.deviceId,
    },
    actor,
    { now: options.now }
  );
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

export interface EvidenceFileDTO {
  objectId: string;
  name: string;
  mimeType: string;
  /** BigInt serialized. */
  sizeBytes: string;
  status: string;
  /** Authenticated stream (evidence uploads are restricted). */
  url: string;
}

export interface EvidenceDTO {
  id: string;
  kind: string;
  kindLabel: string;
  note: string | null;
  caseId: string | null;
  workItemId: string | null;
  stepId: string | null;
  objectType: string;
  objectId: string;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  file: EvidenceFileDTO | null;
}

export type EvidenceQuery =
  | { workItemId: string }
  | { stepId: string }
  | { caseId: string }
  | { objectType: string; objectId: string };

/** Maps rows to DTOs with file metadata and author names (no access check). */
export async function toEvidenceDTOs(rows: EvidenceLink[]): Promise<EvidenceDTO[]> {
  if (rows.length === 0) return [];
  const objectIds = [
    ...new Set(rows.map((r) => r.storageObjectId).filter((id): id is string => Boolean(id))),
  ];
  const userIds = [...new Set(rows.map((r) => r.createdBy))];
  const [objects, users] = await Promise.all([
    objectIds.length
      ? prisma.storageObject.findMany({
          where: { id: { in: objectIds } },
          select: {
            id: true,
            originalName: true,
            declaredMimeType: true,
            detectedMimeType: true,
            sizeBytes: true,
            status: true,
            deletedAt: true,
          },
        })
      : Promise.resolve([]),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
  ]);
  const objectById = new Map(objects.map((o) => [o.id, o]));
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((row) => {
    const object = row.storageObjectId ? objectById.get(row.storageObjectId) : undefined;
    return {
      id: row.id,
      kind: row.kind,
      kindLabel: isEvidenceKind(row.kind) ? EVIDENCE_KIND_LABELS[row.kind] : row.kind,
      note: row.note,
      caseId: row.caseId,
      workItemId: row.workItemId,
      stepId: row.stepId,
      objectType: row.objectType,
      objectId: row.objectId,
      createdBy: row.createdBy,
      createdByName: nameById.get(row.createdBy) ?? null,
      createdAt: row.createdAt.toISOString(),
      file:
        object && !object.deletedAt
          ? {
              objectId: object.id,
              name: object.originalName,
              mimeType: object.detectedMimeType ?? object.declaredMimeType,
              sizeBytes: String(object.sizeBytes),
              status: object.status,
              url: `/app/files/api/objects/${object.id}/content`,
            }
          : null,
    };
  });
}

/** Evidence that counts for a work item (no access check; callers already authorized). */
export async function loadWorkItemEvidence(
  item: Pick<WorkItem, 'id' | 'stepId' | 'objectType' | 'objectId' | 'createdAt'>,
  limit = 100
): Promise<EvidenceDTO[]> {
  const rows = await prisma.evidenceLink.findMany({
    where: evidenceWhereForWorkItem(item),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(limit, 1), 500),
  });
  return toEvidenceDTOs(rows);
}

/**
 * Evidence of a work item, step, case or object. Readable with
 * `operations.view`, by the participants of the target (owner/backup of a
 * related work item) and by the case owner.
 */
export async function listEvidence(
  actor: CurrentUser,
  query: EvidenceQuery,
  options: { limit?: number } = {}
): Promise<EvidenceDTO[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
  const viewer = hasPermission(actor, 'operations.view');
  let where: Prisma.EvidenceLinkWhereInput;
  let allowed = viewer;

  if ('workItemId' in query) {
    const item = await prisma.workItem.findUnique({ where: { id: query.workItemId } });
    if (!item) throw new OperationsError('not_found', 'No se encontró el trabajo');
    if (!allowed) {
      const target = await resolveEvidenceTarget(prisma, { workItemId: item.id });
      allowed = await isEvidenceParticipant(prisma, actor.id, target);
    }
    where = evidenceWhereForWorkItem(item);
  } else if ('stepId' in query) {
    const target = await resolveEvidenceTarget(prisma, { stepId: query.stepId });
    if (!allowed) allowed = await isEvidenceParticipant(prisma, actor.id, target);
    where = { stepId: query.stepId };
  } else if ('caseId' in query) {
    const operationalCase = await prisma.operationalCase.findUnique({
      where: { id: query.caseId },
      select: { id: true, ownerUserId: true },
    });
    if (!operationalCase) throw new OperationsError('not_found', 'No se encontró el expediente');
    // One rule to access a case (channel, snapshot and its evidence).
    if (!allowed) allowed = await authorizeOperationsChannel(actor, 'case', operationalCase.id);
    where = { caseId: operationalCase.id };
  } else {
    if (!OBJECT_TYPE_PATTERN.test(query.objectType) || !query.objectId) {
      throw new OperationsError('invalid_payload', 'Registro inválido');
    }
    if (!allowed) {
      const target = await resolveEvidenceTarget(prisma, {
        objectType: query.objectType,
        objectId: query.objectId,
      });
      allowed = await isEvidenceParticipant(prisma, actor.id, target);
    }
    where = { objectType: query.objectType, objectId: query.objectId };
  }

  if (!allowed) throw new OperationsError('forbidden', 'No tienes acceso a estas evidencias');
  const rows = await prisma.evidenceLink.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });
  return toEvidenceDTOs(rows);
}

/**
 * File access for purpose `evidence`: `operations.view`, the uploader, or a
 * participant of any target that references the file.
 */
export async function canReadEvidenceObject(
  actor: CurrentUser,
  object: Pick<StorageObject, 'id' | 'createdBy'>
): Promise<boolean> {
  if (hasPermission(actor, 'operations.view')) return true;
  if (object.createdBy && object.createdBy === actor.id) return true;
  const links = await prisma.evidenceLink.findMany({
    where: { storageObjectId: object.id },
    take: 20,
  });
  for (const link of links) {
    const workItem = link.workItemId
      ? await prisma.workItem.findUnique({
          where: { id: link.workItemId },
          select: WORK_ITEM_REF_SELECT,
        })
      : null;
    const target: ResolvedEvidenceTarget = {
      caseId: link.caseId,
      workItemId: link.workItemId,
      stepId: link.stepId,
      objectType: link.objectType,
      objectId: link.objectId,
      areaKey: workItem?.areaKey ?? null,
      workItem,
    };
    if (await isEvidenceParticipant(prisma, actor.id, target)) return true;
  }
  return false;
}
