import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import {
  AREA_LABELS,
  WORK_ITEM_OPEN_STATUSES,
  isAreaKey,
  type AreaKey,
} from '@/modules/operations/types';
import { assertControlTowerAccess } from './control-tower-service';

/**
 * "Quién está haciendo qué ahora" (plan 7.7 `personas`). SÓLO SERVIDOR.
 *
 * Por persona: su área, cuánto trabajo tiene abierto y vencido, qué hizo por
 * última vez y hace cuánto. Son dos consultas acotadas:
 * 1. un `groupBy` de `WorkItem` por dueño (índice `ownerUserId, status`);
 * 2. un `DISTINCT ON (actorId)` sobre `OperationalEvent` (índice
 *    `actorId, occurredAt`) que trae SÓLO el último evento de cada persona.
 *
 * Los eventos de la capa de IA (`ai.*`) no cuentan como actividad humana, y los
 * usuarios-bot no aparecen en la lista: son identidades, no personas.
 */

const ACTIVE_MINUTES = 15;
const IDLE_HOURS = 24;
const MAX_PEOPLE = 200;

export type PersonPresence = 'active' | 'idle' | 'inactive' | 'unassigned';

export const PRESENCE_LABELS: Record<PersonPresence, string> = {
  active: 'Activo',
  idle: 'Sin movimiento reciente',
  inactive: 'Sin actividad hoy',
  unassigned: 'Sin trabajo asignado',
};

export interface PersonNow {
  userId: string;
  name: string;
  username: string;
  areaKey: AreaKey | null;
  areaLabel: string | null;
  /** Titular / suplente del área, o líder. */
  role: string | null;
  openWorkItems: number;
  inProgressWorkItems: number;
  overdueWorkItems: number;
  waitingWorkItems: number;
  openRequests: number;
  /** Trabajo más urgente que tiene en la mano. */
  nextTitle: string | null;
  nextDueAt: string | null;
  lastEventType: string | null;
  lastEventAt: string | null;
  lastEventMinutesAgo: number | null;
  lastEventCaseId: string | null;
  presence: PersonPresence;
  presenceLabel: string;
}

export interface PeopleNowResult {
  computedAt: string;
  people: PersonNow[];
  totals: {
    people: number;
    active: number;
    withOverdue: number;
    unassigned: number;
  };
}

interface LastEventRow {
  actorId: string;
  type: string;
  occurredAt: Date;
  caseId: string | null;
}

export interface ListPeopleNowOptions {
  now?: Date;
  /** Sólo las personas de un área. */
  areaKey?: string | null;
  /** Incluye a quien no tiene trabajo abierto (por omisión sí). */
  includeIdle?: boolean;
  limit?: number;
}

/** Área de cada persona según responsables, suplentes y líderes de área. */
async function loadAreaByUser(): Promise<Map<string, { areaKey: AreaKey; role: string }>> {
  const [areas, responsibles] = await Promise.all([
    prisma.area.findMany({
      where: { active: true },
      select: { key: true, leadUserId: true, responsibleArea: true },
    }),
    prisma.responsible.findMany({
      where: { active: true },
      select: { area: true, userId: true, backupUserId: true },
    }),
  ]);
  const responsibleByArea = new Map(responsibles.map((row) => [row.area, row]));
  const out = new Map<string, { areaKey: AreaKey; role: string }>();
  for (const area of areas) {
    if (!isAreaKey(area.key)) continue;
    const areaKey = area.key;
    if (area.leadUserId) out.set(area.leadUserId, { areaKey, role: 'Líder de área' });
    const responsible = responsibleByArea.get(area.responsibleArea || area.key);
    if (!responsible) continue;
    if (responsible.userId && !out.has(responsible.userId)) {
      out.set(responsible.userId, { areaKey, role: 'Responsable' });
    }
    if (responsible.backupUserId && !out.has(responsible.backupUserId)) {
      out.set(responsible.backupUserId, { areaKey, role: 'Suplente' });
    }
  }
  return out;
}

/** Personas con trabajo o actividad reciente, ordenadas por carga vencida. */
export async function listPeopleNow(
  actor: CurrentUser,
  options: ListPeopleNowOptions = {}
): Promise<PeopleNowResult> {
  assertControlTowerAccess(actor);
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 100, 1), MAX_PEOPLE);
  const areaFilter = options.areaKey && isAreaKey(options.areaKey) ? options.areaKey : null;

  const openWork = {
    status: { in: [...WORK_ITEM_OPEN_STATUSES] },
    ...(areaFilter ? { areaKey: areaFilter } : {}),
  };

  const [byOwner, byOwnerOverdue, byOwnerProgress, byOwnerWaiting, requestsByOwner] =
    await Promise.all([
      prisma.workItem.groupBy({ by: ['ownerUserId'], where: openWork, _count: { _all: true } }),
      prisma.workItem.groupBy({
        by: ['ownerUserId'],
        where: { ...openWork, dueAt: { lt: now } },
        _count: { _all: true },
      }),
      prisma.workItem.groupBy({
        by: ['ownerUserId'],
        where: { ...openWork, status: 'in_progress' },
        _count: { _all: true },
      }),
      prisma.workItem.groupBy({
        by: ['ownerUserId'],
        where: { ...openWork, status: 'waiting' },
        _count: { _all: true },
      }),
      prisma.areaRequest.groupBy({
        by: ['ownerUserId'],
        where: {
          status: { in: ['sent', 'acknowledged', 'accepted', 'blocked'] },
          ...(areaFilter ? { toAreaKey: areaFilter } : {}),
        },
        _count: { _all: true },
      }),
    ]);

  const countOf = (
    rows: Array<{ ownerUserId: string; _count: { _all: number } }>,
    userId: string
  ) => rows.find((row) => row.ownerUserId === userId)?._count._all ?? 0;

  const workUserIds = byOwner.map((row) => row.ownerUserId);
  const requestUserIds = requestsByOwner.map((row) => row.ownerUserId);
  const areaByUser = await loadAreaByUser();
  const areaUserIds = areaFilter
    ? [...areaByUser.entries()]
        .filter(([, value]) => value.areaKey === areaFilter)
        .map(([userId]) => userId)
    : [...areaByUser.keys()];

  const candidateIds = [...new Set([...workUserIds, ...requestUserIds, ...areaUserIds])];
  if (candidateIds.length === 0) {
    return {
      computedAt: now.toISOString(),
      people: [],
      totals: { people: 0, active: 0, withOverdue: 0, unassigned: 0 },
    };
  }

  const users = await prisma.user.findMany({
    where: { id: { in: candidateIds }, isActive: true, isBot: false },
    select: { id: true, name: true, username: true },
    take: MAX_PEOPLE,
  });
  if (users.length === 0) {
    return {
      computedAt: now.toISOString(),
      people: [],
      totals: { people: 0, active: 0, withOverdue: 0, unassigned: 0 },
    };
  }
  const userIds = users.map((user) => user.id);

  const [lastEvents, nextItems] = await Promise.all([
    prisma.$queryRaw<LastEventRow[]>(Prisma.sql`
      SELECT DISTINCT ON (e."actorId")
        e."actorId" AS "actorId",
        e."type" AS "type",
        e."occurredAt" AS "occurredAt",
        e."caseId" AS "caseId"
      FROM "OperationalEvent" e
      WHERE e."actorId" IN (${Prisma.join(userIds)})
        AND e."actorType" = 'user'
        AND e."occurredAt" >= ${new Date(now.getTime() - 30 * 86_400_000)}
      ORDER BY e."actorId", e."occurredAt" DESC, e."id" DESC
    `),
    prisma.workItem.findMany({
      where: { ...openWork, ownerUserId: { in: userIds } },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      select: { ownerUserId: true, title: true, dueAt: true },
      take: 2000,
    }),
  ]);

  const lastByUser = new Map(lastEvents.map((row) => [row.actorId, row]));
  const nextByUser = new Map<string, { title: string; dueAt: Date }>();
  for (const item of nextItems) {
    if (nextByUser.has(item.ownerUserId)) continue;
    nextByUser.set(item.ownerUserId, { title: item.title, dueAt: item.dueAt });
  }

  const people: PersonNow[] = users.map((user) => {
    const open = countOf(byOwner, user.id);
    const overdue = countOf(byOwnerOverdue, user.id);
    const area = areaByUser.get(user.id) ?? null;
    const last = lastByUser.get(user.id) ?? null;
    const minutesAgo = last
      ? Math.max(0, Math.floor((now.getTime() - last.occurredAt.getTime()) / 60_000))
      : null;
    let presence: PersonPresence;
    if (minutesAgo !== null && minutesAgo <= ACTIVE_MINUTES) presence = 'active';
    else if (open === 0) presence = 'unassigned';
    else if (minutesAgo === null || minutesAgo > IDLE_HOURS * 60) presence = 'inactive';
    else presence = 'idle';
    const next = nextByUser.get(user.id) ?? null;
    return {
      userId: user.id,
      name: user.name,
      username: user.username,
      areaKey: area?.areaKey ?? null,
      areaLabel: area ? AREA_LABELS[area.areaKey] : null,
      role: area?.role ?? null,
      openWorkItems: open,
      inProgressWorkItems: countOf(byOwnerProgress, user.id),
      overdueWorkItems: overdue,
      waitingWorkItems: countOf(byOwnerWaiting, user.id),
      openRequests: countOf(requestsByOwner, user.id),
      nextTitle: next?.title ?? null,
      nextDueAt: next?.dueAt.toISOString() ?? null,
      lastEventType: last?.type ?? null,
      lastEventAt: last?.occurredAt.toISOString() ?? null,
      lastEventMinutesAgo: minutesAgo,
      lastEventCaseId: last?.caseId ?? null,
      presence,
      presenceLabel: PRESENCE_LABELS[presence],
    };
  });

  const filtered =
    options.includeIdle === false ? people.filter((p) => p.openWorkItems > 0) : people;
  filtered.sort(
    (a, b) =>
      b.overdueWorkItems - a.overdueWorkItems ||
      b.openWorkItems - a.openWorkItems ||
      a.name.localeCompare(b.name, 'es')
  );
  const limited = filtered.slice(0, limit);

  return {
    computedAt: now.toISOString(),
    people: limited,
    totals: {
      people: filtered.length,
      active: filtered.filter((person) => person.presence === 'active').length,
      withOverdue: filtered.filter((person) => person.overdueWorkItems > 0).length,
      unassigned: filtered.filter((person) => person.presence === 'unassigned').length,
    },
  };
}
