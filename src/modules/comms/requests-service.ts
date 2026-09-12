import { Prisma, type InternalRequest, type InternalRequestEvent } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { publishRealtime, REALTIME_CHANNELS } from '@/modules/realtime/realtime-service';
import { resolveFileAccess } from '@/modules/storage/storage-access';
import { isInboxAdmin } from './comms-access';
import { CommsError, assertFound } from './comms-errors';
import { resolveResponsible } from './responsibles-service';
import './comms-storage';

/**
 * Internal requests with a dossier (expediente) and a timeline. A request is
 * auto-assigned through the responsible directory when its type matches an
 * area. Visibility: requester, assignee and channel administrators.
 */

export const REQUEST_STATUSES = ['open', 'in_progress', 'waiting', 'done', 'cancelled'] as const;
export const REQUEST_PRIORITIES = ['normal', 'high', 'urgent'] as const;

export const dossierFactSchema = z.object({
  key: z.string().min(1).max(80),
  value: z.string().max(2000),
  source: z.enum(['user', 'ai']).default('user'),
});

export const createRequestSchema = z.object({
  type: z.string().min(2).max(60),
  title: z.string().min(3).max(200),
  description: z.string().max(5000).optional(),
  priority: z.enum(REQUEST_PRIORITIES).default('normal'),
  dueAt: z.string().datetime().nullable().optional(),
  fileIds: z.array(z.string()).max(20).optional(),
  commConversationId: z.string().nullable().optional(),
  aiConversationId: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
  assigneeUserId: z.string().nullable().optional(),
  facts: z.array(dossierFactSchema).max(50).optional(),
});

export const updateRequestSchema = z.object({
  status: z.enum(REQUEST_STATUSES).optional(),
  assigneeUserId: z.string().nullable().optional(),
  priority: z.enum(REQUEST_PRIORITIES).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  title: z.string().min(3).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  addFileIds: z.array(z.string()).max(20).optional(),
  facts: z.array(dossierFactSchema).max(50).optional(),
});

export const requestEventSchema = z.object({
  type: z.enum(['comment', 'ai_note']).default('comment'),
  body: z.string().min(1).max(4000),
  metadata: z.record(z.unknown()).optional(),
});

export type CreateRequestInput = z.infer<typeof createRequestSchema>;
export type UpdateRequestInput = z.infer<typeof updateRequestSchema>;
export type DossierFact = z.infer<typeof dossierFactSchema> & { addedBy: string; addedAt: string };

export interface RequestEventDTO {
  id: string;
  type: string;
  body: string | null;
  actorUserId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface RequestFileDTO {
  id: string;
  name: string;
  mimeType: string;
  url: string;
}

export interface InternalRequestDTO {
  id: string;
  type: string;
  title: string;
  description: string | null;
  requesterUserId: string;
  requesterName: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  status: string;
  priority: string;
  dueAt: string | null;
  fileIds: string[];
  files: RequestFileDTO[];
  commConversationId: string | null;
  aiConversationId: string | null;
  contactId: string | null;
  contactName: string | null;
  dossier: { facts: DossierFact[] };
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  events?: RequestEventDTO[];
}

function assertRequestsUse(actor: CurrentUser): void {
  if (!hasPermission(actor, 'requests.use') && !isInboxAdmin(actor)) {
    throw new CommsError('Sin permiso para solicitudes internas', 403);
  }
}

function canSee(
  actor: CurrentUser,
  request: Pick<InternalRequest, 'requesterUserId' | 'assigneeUserId'>
): boolean {
  return (
    isInboxAdmin(actor) ||
    request.requesterUserId === actor.id ||
    request.assigneeUserId === actor.id
  );
}

function dossierOf(request: InternalRequest): { facts: DossierFact[] } {
  const raw = (request.dossier as { facts?: DossierFact[] } | null) ?? {};
  return { facts: Array.isArray(raw.facts) ? raw.facts : [] };
}

async function names(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, u.name]));
}

async function filesFor(fileIds: string[]): Promise<RequestFileDTO[]> {
  if (fileIds.length === 0) return [];
  const objects = await prisma.storageObject.findMany({
    where: { id: { in: fileIds }, status: 'ready' },
    select: { id: true, originalName: true, declaredMimeType: true, detectedMimeType: true },
  });
  return objects.map((o) => ({
    id: o.id,
    name: o.originalName,
    mimeType: o.detectedMimeType ?? o.declaredMimeType,
    url: `/app/files/api/objects/${o.id}/content`,
  }));
}

async function toDTOs(
  rows: InternalRequest[],
  events?: Map<string, InternalRequestEvent[]>
): Promise<InternalRequestDTO[]> {
  const map = await names([
    ...rows.flatMap((r) => [r.requesterUserId, r.assigneeUserId]),
    ...(events ? [...events.values()].flat().map((e) => e.actorUserId) : []),
  ]);
  const contactIds = [
    ...new Set(rows.map((r) => r.contactId).filter((x): x is string => Boolean(x))),
  ];
  const contacts = contactIds.length
    ? await prisma.commContact.findMany({
        where: { id: { in: contactIds } },
        select: { id: true, displayName: true },
      })
    : [];
  const contactNames = new Map(contacts.map((c) => [c.id, c.displayName]));
  const out: InternalRequestDTO[] = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      type: r.type,
      title: r.title,
      description: r.description,
      requesterUserId: r.requesterUserId,
      requesterName: map.get(r.requesterUserId) ?? null,
      assigneeUserId: r.assigneeUserId,
      assigneeName: r.assigneeUserId ? (map.get(r.assigneeUserId) ?? null) : null,
      status: r.status,
      priority: r.priority,
      dueAt: r.dueAt?.toISOString() ?? null,
      fileIds: r.fileIds,
      files: events ? await filesFor(r.fileIds) : [],
      commConversationId: r.commConversationId,
      aiConversationId: r.aiConversationId,
      contactId: r.contactId,
      contactName: r.contactId ? (contactNames.get(r.contactId) ?? null) : null,
      dossier: dossierOf(r),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      closedAt: r.closedAt?.toISOString() ?? null,
      events: events
        ? (events.get(r.id) ?? []).map((e) => ({
            id: e.id,
            type: e.type,
            body: e.body,
            actorUserId: e.actorUserId,
            actorName: e.actorUserId ? (map.get(e.actorUserId) ?? null) : null,
            metadata: (e.metadata as Record<string, unknown> | null) ?? null,
            createdAt: e.createdAt.toISOString(),
          }))
        : undefined,
    });
  }
  return out;
}

async function validateFiles(actor: CurrentUser, fileIds: string[]): Promise<string[]> {
  const ok: string[] = [];
  for (const id of [...new Set(fileIds)]) {
    const decision = await resolveFileAccess(actor, id);
    if (!decision || !decision.allowed)
      throw new CommsError('No tienes acceso a uno de los archivos adjuntos', 403);
    if (decision.object.status !== 'ready')
      throw new CommsError('Un archivo adjunto aún no está listo', 409);
    ok.push(id);
  }
  return ok;
}

async function notifyAssignee(
  userId: string | null,
  requestId: string,
  type: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  if (!userId) return;
  await publishRealtime(REALTIME_CHANNELS.user(userId), 'request', {
    requestId,
    type,
    ...extra,
  }).catch(() => undefined);
}

/** Creates the request, attaches files and auto-assigns via the responsible directory. */
export async function createRequest(
  actor: CurrentUser,
  input: CreateRequestInput
): Promise<InternalRequestDTO> {
  assertRequestsUse(actor);
  const fileIds = input.fileIds ? await validateFiles(actor, input.fileIds) : [];
  let assigneeUserId = input.assigneeUserId ?? null;
  let assignmentNote: string | null = null;
  if (assigneeUserId) {
    const target = await prisma.user.findUnique({
      where: { id: assigneeUserId },
      select: { isActive: true, name: true },
    });
    if (!target || !target.isActive) throw new CommsError('Usuario asignado no válido', 400);
    assignmentNote = `Asignada a ${target.name}`;
  } else {
    const responsible = await resolveResponsible(input.type);
    if (responsible) {
      assigneeUserId = responsible.userId;
      assignmentNote = `Asignada automáticamente a ${responsible.userName} (${responsible.label}${responsible.isBackup ? ', respaldo' : ''})`;
    }
  }
  const now = new Date().toISOString();
  const facts: DossierFact[] = (input.facts ?? []).map((f) => ({
    ...f,
    addedBy: actor.id,
    addedAt: now,
  }));
  const request = await prisma.internalRequest.create({
    data: {
      type: input.type.trim().toLowerCase(),
      title: input.title.trim(),
      description: input.description?.trim() || null,
      requesterUserId: actor.id,
      assigneeUserId,
      priority: input.priority,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      fileIds,
      commConversationId: input.commConversationId ?? null,
      aiConversationId: input.aiConversationId ?? null,
      contactId: input.contactId ?? null,
      dossier: { facts } as unknown as Prisma.InputJsonValue,
    },
  });
  await prisma.internalRequestEvent.create({
    data: {
      requestId: request.id,
      type: 'created',
      body: `Solicitud creada por ${actor.name}`,
      actorUserId: actor.id,
    },
  });
  if (assigneeUserId) {
    await prisma.internalRequestEvent.create({
      data: {
        requestId: request.id,
        type: 'assigned',
        body: assignmentNote,
        actorUserId: actor.id,
        metadata: { assigneeUserId },
      },
    });
  }
  if (fileIds.length > 0) {
    await prisma.internalRequestEvent.create({
      data: {
        requestId: request.id,
        type: 'file_added',
        body: `${fileIds.length} archivo(s) adjunto(s)`,
        actorUserId: actor.id,
        metadata: { fileIds },
      },
    });
  }
  await notifyAssignee(assigneeUserId, request.id, 'assigned', { title: request.title });
  return (await toDTOs([request]))[0];
}

export async function listRequests(
  actor: CurrentUser,
  filters: {
    scope?: 'mine' | 'assigned' | 'all';
    status?: string;
    type?: string;
    page?: number;
    pageSize?: number;
  } = {}
): Promise<{ items: InternalRequestDTO[]; total: number; page: number; pageSize: number }> {
  assertRequestsUse(actor);
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));
  const where: Prisma.InternalRequestWhereInput = {};
  const scope = filters.scope ?? 'all';
  if (scope === 'mine') where.requesterUserId = actor.id;
  else if (scope === 'assigned') where.assigneeUserId = actor.id;
  else if (!isInboxAdmin(actor))
    where.OR = [{ requesterUserId: actor.id }, { assigneeUserId: actor.id }];
  if (filters.status && filters.status !== 'all') where.status = filters.status;
  if (filters.type) where.type = filters.type.toLowerCase();
  const [rows, total] = await Promise.all([
    prisma.internalRequest.findMany({
      where,
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.internalRequest.count({ where }),
  ]);
  return { items: await toDTOs(rows), total, page, pageSize };
}

export async function getRequest(actor: CurrentUser, id: string): Promise<InternalRequestDTO> {
  assertRequestsUse(actor);
  const request = assertFound(
    await prisma.internalRequest.findUnique({ where: { id } }),
    'Solicitud no encontrada'
  );
  if (!canSee(actor, request)) throw new CommsError('Solicitud no encontrada', 404);
  const events = await prisma.internalRequestEvent.findMany({
    where: { requestId: id },
    orderBy: { createdAt: 'asc' },
  });
  return (await toDTOs([request], new Map([[id, events]])))[0];
}

export async function updateRequest(
  actor: CurrentUser,
  id: string,
  patch: UpdateRequestInput
): Promise<InternalRequestDTO> {
  assertRequestsUse(actor);
  const request = assertFound(
    await prisma.internalRequest.findUnique({ where: { id } }),
    'Solicitud no encontrada'
  );
  if (!canSee(actor, request)) throw new CommsError('Solicitud no encontrada', 404);
  const data: Prisma.InternalRequestUpdateInput = {};
  const events: Prisma.InternalRequestEventUncheckedCreateInput[] = [];

  if (patch.status !== undefined && patch.status !== request.status) {
    data.status = patch.status;
    data.closedAt = patch.status === 'done' || patch.status === 'cancelled' ? new Date() : null;
    events.push({
      requestId: id,
      type: 'status_changed',
      body: `Estado: ${request.status} → ${patch.status}`,
      actorUserId: actor.id,
      metadata: { from: request.status, to: patch.status },
    });
  }
  if (patch.assigneeUserId !== undefined && patch.assigneeUserId !== request.assigneeUserId) {
    let name = 'nadie';
    if (patch.assigneeUserId) {
      const target = await prisma.user.findUnique({
        where: { id: patch.assigneeUserId },
        select: { isActive: true, name: true },
      });
      if (!target || !target.isActive) throw new CommsError('Usuario asignado no válido', 400);
      name = target.name;
    }
    data.assigneeUserId = patch.assigneeUserId;
    events.push({
      requestId: id,
      type: 'assigned',
      body: `Asignada a ${name}`,
      actorUserId: actor.id,
      metadata: { assigneeUserId: patch.assigneeUserId },
    });
  }
  if (patch.priority !== undefined) data.priority = patch.priority;
  if (patch.dueAt !== undefined) data.dueAt = patch.dueAt ? new Date(patch.dueAt) : null;
  if (patch.title !== undefined) data.title = patch.title.trim();
  if (patch.description !== undefined) data.description = patch.description?.trim() || null;
  if (patch.addFileIds && patch.addFileIds.length > 0) {
    const added = (await validateFiles(actor, patch.addFileIds)).filter(
      (f) => !request.fileIds.includes(f)
    );
    if (added.length > 0) {
      data.fileIds = [...request.fileIds, ...added];
      events.push({
        requestId: id,
        type: 'file_added',
        body: `${added.length} archivo(s) adjunto(s)`,
        actorUserId: actor.id,
        metadata: { fileIds: added },
      });
    }
  }
  if (patch.facts && patch.facts.length > 0) {
    const now = new Date().toISOString();
    const current = dossierOf(request).facts;
    const added: DossierFact[] = patch.facts.map((f) => ({
      ...f,
      addedBy: actor.id,
      addedAt: now,
    }));
    data.dossier = { facts: [...current, ...added] } as unknown as Prisma.InputJsonValue;
    events.push({
      requestId: id,
      type: added.some((f) => f.source === 'ai') ? 'ai_note' : 'comment',
      body: `Expediente: ${added
        .map((f) => `${f.key}: ${f.value}`)
        .join(' · ')
        .slice(0, 1000)}`,
      actorUserId: actor.id,
      metadata: { facts: added.length },
    });
  }
  const updated = await prisma.internalRequest.update({ where: { id }, data });
  for (const event of events) await prisma.internalRequestEvent.create({ data: event });
  if (data.assigneeUserId !== undefined && updated.assigneeUserId) {
    await notifyAssignee(updated.assigneeUserId, id, 'assigned', { title: updated.title });
  } else if (events.length > 0) {
    await notifyAssignee(updated.assigneeUserId, id, 'updated');
    if (updated.requesterUserId !== actor.id)
      await notifyAssignee(updated.requesterUserId, id, 'updated');
  }
  return getRequest(actor, id);
}

export async function addRequestEvent(
  actor: CurrentUser,
  id: string,
  input: z.infer<typeof requestEventSchema>
): Promise<RequestEventDTO> {
  assertRequestsUse(actor);
  const request = assertFound(
    await prisma.internalRequest.findUnique({ where: { id } }),
    'Solicitud no encontrada'
  );
  if (!canSee(actor, request)) throw new CommsError('Solicitud no encontrada', 404);
  const event = await prisma.internalRequestEvent.create({
    data: {
      requestId: id,
      type: input.type,
      body: input.body.trim(),
      actorUserId: actor.id,
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
  await prisma.internalRequest.update({ where: { id }, data: { updatedAt: new Date() } });
  const targets = new Set([request.assigneeUserId, request.requesterUserId]);
  targets.delete(actor.id);
  for (const userId of targets) await notifyAssignee(userId ?? null, id, 'comment');
  return {
    id: event.id,
    type: event.type,
    body: event.body,
    actorUserId: actor.id,
    actorName: actor.name,
    metadata: (event.metadata as Record<string, unknown> | null) ?? null,
    createdAt: event.createdAt.toISOString(),
  };
}
