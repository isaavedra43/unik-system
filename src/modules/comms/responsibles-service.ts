import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { assertInboxAdmin } from './comms-access';
import { CommsError, assertFound } from './comms-errors';
import { normalizeName } from './normalize';

/**
 * Directory of responsible people per area ("ventas", "instalaciones",
 * "cobranza", "soporte"...). Areas are free text normalized to a slug so
 * requests and the assistant can resolve "who handles X" with a backup.
 */

export const responsibleInputSchema = z.object({
  area: z.string().min(2).max(60),
  label: z.string().min(2).max(120),
  userId: z.string().min(1),
  backupUserId: z.string().nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  active: z.boolean().optional(),
});

export type ResponsibleInput = z.infer<typeof responsibleInputSchema>;

export interface ResponsibleDTO {
  id: string;
  area: string;
  label: string;
  userId: string;
  userName: string | null;
  backupUserId: string | null;
  backupUserName: string | null;
  description: string | null;
  active: boolean;
  updatedAt: string;
}

export function areaSlug(area: string): string {
  return normalizeName(area).replace(/\s+/g, '_');
}

async function names(ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, u.name]));
}

export async function listResponsibles(
  actor: CurrentUser,
  options: { includeInactive?: boolean } = {}
): Promise<ResponsibleDTO[]> {
  const canRead =
    actor.isSuperAdmin ||
    ['inbox.use', 'inbox.admin', 'requests.use'].some((key) =>
      actor.permissionKeys.includes(key as never)
    );
  if (!canRead) throw new CommsError('Sin permiso', 403);
  const rows = await prisma.responsible.findMany({
    where: options.includeInactive ? {} : { active: true },
    orderBy: { area: 'asc' },
  });
  const map = await names(rows.flatMap((r) => [r.userId, r.backupUserId]));
  return rows.map((r) => ({
    id: r.id,
    area: r.area,
    label: r.label,
    userId: r.userId,
    userName: map.get(r.userId) ?? null,
    backupUserId: r.backupUserId,
    backupUserName: r.backupUserId ? (map.get(r.backupUserId) ?? null) : null,
    description: r.description,
    active: r.active,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

async function assertActiveUser(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } });
  if (!user || !user.isActive) throw new CommsError('Usuario no válido o inactivo', 400);
}

export async function createResponsible(
  actor: CurrentUser,
  input: ResponsibleInput
): Promise<ResponsibleDTO> {
  assertInboxAdmin(actor);
  const area = areaSlug(input.area);
  if (!area) throw new CommsError('Área inválida', 400);
  await assertActiveUser(input.userId);
  if (input.backupUserId) await assertActiveUser(input.backupUserId);
  const existing = await prisma.responsible.findUnique({ where: { area } });
  if (existing) throw new CommsError('Ya existe un responsable para esa área', 409);
  const row = await prisma.responsible.create({
    data: {
      area,
      label: input.label,
      userId: input.userId,
      backupUserId: input.backupUserId ?? null,
      description: input.description ?? null,
      active: input.active ?? true,
    },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'comms.responsible.created',
    targetType: 'responsible',
    targetId: row.id,
    metadata: { area },
  });
  return (await listResponsibles(actor, { includeInactive: true })).find((r) => r.id === row.id)!;
}

export async function updateResponsible(
  actor: CurrentUser,
  id: string,
  patch: Partial<ResponsibleInput>
): Promise<ResponsibleDTO> {
  assertInboxAdmin(actor);
  assertFound(await prisma.responsible.findUnique({ where: { id } }), 'Responsable no encontrado');
  if (patch.userId) await assertActiveUser(patch.userId);
  if (patch.backupUserId) await assertActiveUser(patch.backupUserId);
  const data: Record<string, unknown> = {};
  if (patch.area !== undefined) data.area = areaSlug(patch.area);
  if (patch.label !== undefined) data.label = patch.label;
  if (patch.userId !== undefined) data.userId = patch.userId;
  if (patch.backupUserId !== undefined) data.backupUserId = patch.backupUserId;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.active !== undefined) data.active = patch.active;
  const row = await prisma.responsible.update({ where: { id }, data });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'comms.responsible.updated',
    targetType: 'responsible',
    targetId: id,
    metadata: { fields: Object.keys(patch) },
  });
  return (await listResponsibles(actor, { includeInactive: true })).find((r) => r.id === row.id)!;
}

export async function deleteResponsible(actor: CurrentUser, id: string): Promise<void> {
  assertInboxAdmin(actor);
  assertFound(await prisma.responsible.findUnique({ where: { id } }), 'Responsable no encontrado');
  await prisma.responsible.delete({ where: { id } });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'comms.responsible.deleted',
    targetType: 'responsible',
    targetId: id,
  });
}

export interface ResolvedResponsible {
  area: string;
  label: string;
  userId: string;
  userName: string;
  isBackup: boolean;
  backupUserId: string | null;
  backupUserName: string | null;
}

/** Who handles an area right now: the primary if active, otherwise the backup. */
export async function resolveResponsible(area: string): Promise<ResolvedResponsible | null> {
  const slug = areaSlug(area);
  if (!slug) return null;
  const row =
    (await prisma.responsible.findUnique({ where: { area: slug } })) ??
    (await prisma.responsible.findFirst({
      where: {
        active: true,
        OR: [{ area: { contains: slug } }, { label: { contains: area, mode: 'insensitive' } }],
      },
    }));
  if (!row || !row.active) return null;
  const users = await prisma.user.findMany({
    where: { id: { in: [row.userId, row.backupUserId].filter((x): x is string => Boolean(x)) } },
    select: { id: true, name: true, isActive: true },
  });
  const primary = users.find((u) => u.id === row.userId);
  const backup = row.backupUserId ? users.find((u) => u.id === row.backupUserId) : undefined;
  const chosen = primary?.isActive ? primary : backup?.isActive ? backup : null;
  if (!chosen) return null;
  return {
    area: row.area,
    label: row.label,
    userId: chosen.id,
    userName: chosen.name,
    isBackup: chosen.id !== row.userId,
    backupUserId: backup?.id ?? null,
    backupUserName: backup?.name ?? null,
  };
}
