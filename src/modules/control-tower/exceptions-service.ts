import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { escapeLike } from '@/modules/areas/work-rows-sql';
import {
  AREA_LABELS,
  AREA_REQUEST_OPEN_STATUSES,
  CASE_OPEN_STATUSES,
  INCIDENT_KIND_LABELS,
  INCIDENT_OPEN_STATUSES,
  INCIDENT_SEVERITY_LABELS,
  WORK_ITEM_OPEN_STATUSES,
  isAreaKey,
} from '@/modules/operations/types';
import { assertControlTowerAccess } from './control-tower-service';

/**
 * Excepciones de la Torre de Control (plan 7.7 `excepciones`). SÓLO SERVIDOR.
 *
 * Una sola tabla con todo lo que se salió del camino: trabajos vencidos y
 * escalados, incidencias abiertas, solicitudes vencidas o bloqueadas, entregas
 * en conflicto y expedientes bloqueados o sin movimiento.
 *
 * Se arma con `$queryRaw` parametrizado (plan 13): cada rama proyecta LAS
 * MISMAS columnas, se unen con `UNION ALL` y el filtro, el orden y la
 * paginación se aplican una sola vez encima. Ningún valor escrito por una
 * persona entra en el texto del SQL: búsquedas, tipos, áreas y topes viajan
 * como parámetros, y las columnas de ordenamiento son lista blanca.
 */

export const EXCEPTION_KINDS = [
  'work_overdue',
  'work_escalated',
  'incident',
  'request_overdue',
  'request_blocked',
  'delivery_conflict',
  'case_blocked',
  'case_stuck',
] as const;

export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const EXCEPTION_KIND_LABELS: Record<ExceptionKind, string> = {
  work_overdue: 'Trabajo vencido',
  work_escalated: 'Trabajo escalado',
  incident: 'Incidencia abierta',
  request_overdue: 'Solicitud vencida',
  request_blocked: 'Solicitud bloqueada',
  delivery_conflict: 'Entrega en conflicto',
  case_blocked: 'Expediente bloqueado',
  case_stuck: 'Expediente sin movimiento',
};

const SEVERITY_LABELS: Record<string, string> = {
  ...INCIDENT_SEVERITY_LABELS,
};

/** Minutos sin movimiento para considerar atorado un expediente. */
const STUCK_MINUTES = 24 * 60;
/** Minutos esperando a Zoho antes de tratarlo como excepción. */
const EXTERNAL_STALE_MINUTES = 60;

const SORT_COLUMNS = {
  since: '"since"',
  dueAt: '"dueAt"',
  severity: '"severityRank"',
  caseNumber: '"caseNumber"',
  areaKey: '"areaKey"',
} as const;

export type ExceptionSortField = keyof typeof SORT_COLUMNS;

export const exceptionQuerySchema = z.object({
  kind: z.array(z.enum(EXCEPTION_KINDS)).max(EXCEPTION_KINDS.length).default([]),
  areaKey: z.array(z.string().trim().max(40)).max(10).default([]),
  severity: z
    .array(z.enum(['low', 'medium', 'high', 'critical']))
    .max(4)
    .default([]),
  search: z.string().trim().max(120).default(''),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  page_size: z.coerce.number().int().min(5).max(200).default(50),
  sort: z.enum(['since', 'dueAt', 'severity', 'caseNumber', 'areaKey']).default('severity'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

export type ExceptionQueryInput = z.input<typeof exceptionQuerySchema>;
export type ExceptionQuery = z.output<typeof exceptionQuerySchema>;

export interface CtExceptionRow {
  id: string;
  kind: ExceptionKind;
  kindLabel: string;
  areaKey: string;
  areaLabel: string;
  caseId: string | null;
  caseNumber: string | null;
  customerName: string | null;
  title: string;
  detail: string | null;
  status: string;
  severity: string;
  severityLabel: string;
  ownerUserId: string | null;
  ownerName: string | null;
  dueAt: string | null;
  since: string;
  ageMinutes: number;
  objectType: string;
  objectId: string;
  version: number;
  extra: Record<string, unknown>;
}

export interface ExceptionsPage {
  data: CtExceptionRow[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  counts: Array<{ kind: ExceptionKind; label: string; count: number }>;
  computedAt: string;
}

interface ExceptionRecord {
  kind: string;
  sourceId: string;
  areaKey: string | null;
  caseId: string | null;
  caseNumber: string | null;
  customerName: string | null;
  title: string;
  detail: string | null;
  status: string;
  severity: string;
  severityRank: number;
  ownerUserId: string | null;
  dueAt: Date | null;
  since: Date;
  objectType: string;
  objectId: string;
  version: number;
  extra: Record<string, unknown> | null;
}

const COLUMNS = [
  'kind',
  'sourceId',
  'areaKey',
  'caseId',
  'caseNumber',
  'customerName',
  'title',
  'detail',
  'status',
  'severity',
  'severityRank',
  'ownerUserId',
  'dueAt',
  'since',
  'objectType',
  'objectId',
  'version',
  'extra',
] as const;

type ExceptionColumn = (typeof COLUMNS)[number];

function branch(input: {
  kind: ExceptionKind;
  from: Prisma.Sql;
  where: Prisma.Sql;
  columns: Partial<Record<ExceptionColumn, Prisma.Sql>>;
}): Prisma.Sql {
  const defaults: Record<ExceptionColumn, Prisma.Sql> = {
    kind: Prisma.sql`${input.kind}::text`,
    sourceId: Prisma.sql`NULL::text`,
    areaKey: Prisma.sql`'administracion'::text`,
    caseId: Prisma.sql`NULL::text`,
    caseNumber: Prisma.sql`NULL::text`,
    customerName: Prisma.sql`NULL::text`,
    title: Prisma.sql`''::text`,
    detail: Prisma.sql`NULL::text`,
    status: Prisma.sql`''::text`,
    severity: Prisma.sql`'medium'::text`,
    severityRank: Prisma.sql`2::int`,
    ownerUserId: Prisma.sql`NULL::text`,
    dueAt: Prisma.sql`NULL::timestamp`,
    since: Prisma.sql`now()::timestamp`,
    objectType: Prisma.sql`''::text`,
    objectId: Prisma.sql`''::text`,
    version: Prisma.sql`1::int`,
    extra: Prisma.sql`'{}'::jsonb`,
  };
  const selected = COLUMNS.map((name) => {
    const expression = input.columns[name] ?? defaults[name];
    return Prisma.sql`${expression} AS ${Prisma.raw(`"${name}"`)}`;
  });
  return Prisma.sql`SELECT ${Prisma.join(selected, ', ')} ${input.from} ${input.where}`;
}

/** Severidad por antigüedad: mientras más tiempo vencido, más arriba aparece. */
function overdueSeverity(minutesColumn: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN ${minutesColumn} >= 1440 THEN 'critical'
    WHEN ${minutesColumn} >= 480 THEN 'high'
    WHEN ${minutesColumn} >= 120 THEN 'medium'
    ELSE 'low' END`;
}

function overdueRank(minutesColumn: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN ${minutesColumn} >= 1440 THEN 4
    WHEN ${minutesColumn} >= 480 THEN 3
    WHEN ${minutesColumn} >= 120 THEN 2
    ELSE 1 END`;
}

function exceptionBranches(now: Date): Array<{ kind: ExceptionKind; sql: Prisma.Sql }> {
  const workOverdueMinutes = Prisma.sql`EXTRACT(EPOCH FROM (${now} - w."dueAt")) / 60.0`;
  const requestOverdueMinutes = Prisma.sql`EXTRACT(EPOCH FROM (${now} - r."dueAt")) / 60.0`;
  const caseJoin = Prisma.sql`LEFT JOIN "OperationalCase" c ON c."id" = w."caseId"`;

  return [
    {
      kind: 'work_overdue',
      sql: branch({
        kind: 'work_overdue',
        from: Prisma.sql`FROM "WorkItem" w ${caseJoin}`,
        where: Prisma.sql`WHERE w."status" IN (${Prisma.join([...WORK_ITEM_OPEN_STATUSES])})
          AND w."status" <> 'escalated'
          AND w."dueAt" < ${now}`,
        columns: {
          sourceId: Prisma.sql`w."id"`,
          areaKey: Prisma.sql`w."areaKey"`,
          caseId: Prisma.sql`w."caseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`w."title"`,
          detail: Prisma.sql`w."description"`,
          status: Prisma.sql`w."status"`,
          severity: overdueSeverity(workOverdueMinutes),
          severityRank: overdueRank(workOverdueMinutes),
          ownerUserId: Prisma.sql`w."ownerUserId"`,
          dueAt: Prisma.sql`w."dueAt"`,
          since: Prisma.sql`w."dueAt"`,
          objectType: Prisma.sql`'work_item'::text`,
          objectId: Prisma.sql`w."id"`,
          version: Prisma.sql`w."version"`,
          extra: Prisma.sql`jsonb_build_object(
            'workItemKind', w."kind",
            'backupUserId', w."backupUserId",
            'escalationLevel', w."escalationLevel",
            'waitReason', w."waitReason"
          )`,
        },
      }),
    },
    {
      kind: 'work_escalated',
      sql: branch({
        kind: 'work_escalated',
        from: Prisma.sql`FROM "WorkItem" w ${caseJoin}`,
        where: Prisma.sql`WHERE w."status" = 'escalated'`,
        columns: {
          sourceId: Prisma.sql`w."id"`,
          areaKey: Prisma.sql`w."areaKey"`,
          caseId: Prisma.sql`w."caseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`w."title"`,
          detail: Prisma.sql`w."description"`,
          status: Prisma.sql`w."status"`,
          severity: Prisma.sql`CASE WHEN w."escalationLevel" >= 2 THEN 'critical' ELSE 'high' END`,
          severityRank: Prisma.sql`CASE WHEN w."escalationLevel" >= 2 THEN 4 ELSE 3 END`,
          ownerUserId: Prisma.sql`w."ownerUserId"`,
          dueAt: Prisma.sql`w."dueAt"`,
          since: Prisma.sql`COALESCE(w."escalatedAt", w."dueAt")`,
          objectType: Prisma.sql`'work_item'::text`,
          objectId: Prisma.sql`w."id"`,
          version: Prisma.sql`w."version"`,
          extra: Prisma.sql`jsonb_build_object(
            'workItemKind', w."kind",
            'escalationLevel', w."escalationLevel",
            'backupUserId', w."backupUserId"
          )`,
        },
      }),
    },
    {
      kind: 'incident',
      sql: branch({
        kind: 'incident',
        from: Prisma.sql`FROM "Incident" i LEFT JOIN "OperationalCase" c ON c."id" = i."caseId"`,
        where: Prisma.sql`WHERE i."status" IN (${Prisma.join([...INCIDENT_OPEN_STATUSES])})`,
        columns: {
          sourceId: Prisma.sql`i."id"`,
          areaKey: Prisma.sql`i."areaKey"`,
          caseId: Prisma.sql`i."caseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`i."title"`,
          detail: Prisma.sql`i."detail" ->> 'reason'`,
          status: Prisma.sql`i."status"`,
          severity: Prisma.sql`i."severity"`,
          severityRank: Prisma.sql`CASE i."severity"
            WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END`,
          ownerUserId: Prisma.sql`i."ownerUserId"`,
          since: Prisma.sql`i."openedAt"`,
          objectType: Prisma.sql`'incident'::text`,
          objectId: Prisma.sql`i."id"`,
          version: Prisma.sql`i."version"`,
          extra: Prisma.sql`jsonb_build_object('incidentKind', i."kind", 'dedupeKey', i."dedupeKey")`,
        },
      }),
    },
    {
      kind: 'request_overdue',
      sql: branch({
        kind: 'request_overdue',
        from: Prisma.sql`FROM "AreaRequest" r LEFT JOIN "OperationalCase" c ON c."id" = r."caseId"`,
        where: Prisma.sql`WHERE (
            (r."status" IN (${Prisma.join([...AREA_REQUEST_OPEN_STATUSES])}) AND r."dueAt" < ${now})
            OR r."status" = 'expired'
          )`,
        columns: {
          sourceId: Prisma.sql`r."id"`,
          areaKey: Prisma.sql`r."toAreaKey"`,
          caseId: Prisma.sql`r."caseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`r."title"`,
          detail: Prisma.sql`r."freeText"`,
          status: Prisma.sql`r."status"`,
          severity: Prisma.sql`CASE WHEN r."blocksDelivery" THEN 'high' ELSE ${overdueSeverity(requestOverdueMinutes)} END`,
          severityRank: Prisma.sql`CASE WHEN r."blocksDelivery" THEN 3 ELSE ${overdueRank(requestOverdueMinutes)} END`,
          ownerUserId: Prisma.sql`r."ownerUserId"`,
          dueAt: Prisma.sql`r."dueAt"`,
          since: Prisma.sql`r."dueAt"`,
          objectType: Prisma.sql`'area_request'::text`,
          objectId: Prisma.sql`r."id"`,
          version: Prisma.sql`r."version"`,
          extra: Prisma.sql`jsonb_build_object(
            'requestKind', r."kind",
            'fromAreaKey', r."fromAreaKey",
            'toAreaKey', r."toAreaKey",
            'blocksDelivery', r."blocksDelivery",
            'workItemId', r."workItemId"
          )`,
        },
      }),
    },
    {
      kind: 'request_blocked',
      sql: branch({
        kind: 'request_blocked',
        from: Prisma.sql`FROM "AreaRequest" r LEFT JOIN "OperationalCase" c ON c."id" = r."caseId"`,
        where: Prisma.sql`WHERE r."status" = 'blocked'`,
        columns: {
          sourceId: Prisma.sql`r."id"`,
          areaKey: Prisma.sql`r."fromAreaKey"`,
          caseId: Prisma.sql`r."caseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`r."title"`,
          detail: Prisma.sql`r."answer" ->> 'reason'`,
          status: Prisma.sql`r."status"`,
          severity: Prisma.sql`CASE WHEN r."blocksDelivery" THEN 'critical' ELSE 'high' END`,
          severityRank: Prisma.sql`CASE WHEN r."blocksDelivery" THEN 4 ELSE 3 END`,
          ownerUserId: Prisma.sql`r."ownerUserId"`,
          dueAt: Prisma.sql`r."dueAt"`,
          since: Prisma.sql`r."updatedAt"`,
          objectType: Prisma.sql`'area_request'::text`,
          objectId: Prisma.sql`r."id"`,
          version: Prisma.sql`r."version"`,
          extra: Prisma.sql`jsonb_build_object(
            'requestKind', r."kind",
            'fromAreaKey', r."fromAreaKey",
            'toAreaKey', r."toAreaKey",
            'blocksDelivery', r."blocksDelivery"
          )`,
        },
      }),
    },
    {
      kind: 'delivery_conflict',
      sql: branch({
        kind: 'delivery_conflict',
        from: Prisma.sql`FROM "DeliveryOrder" d LEFT JOIN "OperationalCase" c ON c."id" = d."caseId"`,
        where: Prisma.sql`WHERE d."status" IN ('conflict', 'failed')
          OR (d."status" = 'pending_external'
              AND COALESCE(d."zohoLastAttemptAt", d."updatedAt") < ${new Date(now.getTime() - EXTERNAL_STALE_MINUTES * 60_000)})`,
        columns: {
          sourceId: Prisma.sql`d."id"`,
          areaKey: Prisma.sql`'logistica'::text`,
          caseId: Prisma.sql`d."caseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`COALESCE('Entrega ' || COALESCE(c."caseNumber", d."id"), 'Entrega')`,
          detail: Prisma.sql`COALESCE(d."zohoError", d."conflictDetail" ->> 'reason')`,
          status: Prisma.sql`d."status"`,
          severity: Prisma.sql`CASE WHEN d."status" = 'failed' THEN 'critical' WHEN d."status" = 'conflict' THEN 'high' ELSE 'medium' END`,
          severityRank: Prisma.sql`CASE WHEN d."status" = 'failed' THEN 4 WHEN d."status" = 'conflict' THEN 3 ELSE 2 END`,
          dueAt: Prisma.sql`d."plannedDate"`,
          since: Prisma.sql`COALESCE(d."zohoLastAttemptAt", d."updatedAt")`,
          objectType: Prisma.sql`'delivery_order'::text`,
          objectId: Prisma.sql`d."id"`,
          version: Prisma.sql`d."version"`,
          extra: Prisma.sql`jsonb_build_object(
            'mode', d."mode",
            'carrier', d."carrier",
            'zohoSyncState', d."zohoSyncState",
            'zohoPackageId', d."zohoPackageId"
          )`,
        },
      }),
    },
    {
      kind: 'case_blocked',
      sql: branch({
        kind: 'case_blocked',
        from: Prisma.sql`FROM "OperationalCase" c`,
        where: Prisma.sql`WHERE c."status" = 'blocked'`,
        columns: {
          sourceId: Prisma.sql`c."id"`,
          areaKey: Prisma.sql`'ventas'::text`,
          caseId: Prisma.sql`c."id"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`COALESCE(c."caseNumber", 'Expediente') || ' bloqueado'`,
          detail: Prisma.sql`c."closeReason"`,
          status: Prisma.sql`c."status"`,
          severity: Prisma.sql`'high'::text`,
          severityRank: Prisma.sql`3::int`,
          ownerUserId: Prisma.sql`c."ownerUserId"`,
          dueAt: Prisma.sql`c."promisedAt"`,
          since: Prisma.sql`c."lastActivityAt"`,
          objectType: Prisma.sql`'operational_case'::text`,
          objectId: Prisma.sql`c."id"`,
          version: Prisma.sql`c."version"`,
          extra: Prisma.sql`jsonb_build_object('phase', c."phase", 'salesOrderNumber', c."salesOrderNumber")`,
        },
      }),
    },
    {
      kind: 'case_stuck',
      sql: branch({
        kind: 'case_stuck',
        from: Prisma.sql`FROM "OperationalCase" c`,
        where: Prisma.sql`WHERE c."status" IN (${Prisma.join([...CASE_OPEN_STATUSES])})
          AND c."status" <> 'blocked'
          AND c."lastActivityAt" < ${new Date(now.getTime() - STUCK_MINUTES * 60_000)}`,
        columns: {
          sourceId: Prisma.sql`c."id"`,
          areaKey: Prisma.sql`'ventas'::text`,
          caseId: Prisma.sql`c."id"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`COALESCE(c."caseNumber", 'Expediente') || ' sin movimiento'`,
          detail: Prisma.sql`NULL::text`,
          status: Prisma.sql`c."status"`,
          severity: Prisma.sql`CASE WHEN c."promisedAt" IS NOT NULL AND c."promisedAt" < ${now} THEN 'high' ELSE 'medium' END`,
          severityRank: Prisma.sql`CASE WHEN c."promisedAt" IS NOT NULL AND c."promisedAt" < ${now} THEN 3 ELSE 2 END`,
          ownerUserId: Prisma.sql`c."ownerUserId"`,
          dueAt: Prisma.sql`c."promisedAt"`,
          since: Prisma.sql`c."lastActivityAt"`,
          objectType: Prisma.sql`'operational_case'::text`,
          objectId: Prisma.sql`c."id"`,
          version: Prisma.sql`c."version"`,
          extra: Prisma.sql`jsonb_build_object('phase', c."phase", 'salesOrderNumber', c."salesOrderNumber")`,
        },
      }),
    },
  ];
}

function whereClause(query: ExceptionQuery): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (query.areaKey.length > 0) {
    const areas = query.areaKey.filter(isAreaKey);
    conditions.push(
      areas.length > 0 ? Prisma.sql`rows."areaKey" IN (${Prisma.join(areas)})` : Prisma.sql`FALSE`
    );
  }
  if (query.severity.length > 0) {
    conditions.push(Prisma.sql`rows."severity" IN (${Prisma.join(query.severity)})`);
  }
  if (query.search) {
    const term = `%${escapeLike(query.search)}%`;
    conditions.push(Prisma.sql`(
      rows."title" ILIKE ${term} ESCAPE '\\'
      OR COALESCE(rows."caseNumber", '') ILIKE ${term} ESCAPE '\\'
      OR COALESCE(rows."customerName", '') ILIKE ${term} ESCAPE '\\'
      OR COALESCE(rows."detail", '') ILIKE ${term} ESCAPE '\\'
    )`);
  }
  if (conditions.length === 0) return Prisma.empty;
  return Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;
}

function unionOf(query: ExceptionQuery, now: Date): Prisma.Sql {
  const wanted = new Set<string>(query.kind);
  const branches = exceptionBranches(now)
    .filter((entry) => wanted.size === 0 || wanted.has(entry.kind))
    .map((entry) => entry.sql);
  if (branches.length === 0) {
    // Ninguna rama seleccionada: una consulta vacía con las mismas columnas.
    return exceptionBranches(now)[0].sql;
  }
  return Prisma.join(branches, ' UNION ALL ');
}

async function resolveNames(rows: ExceptionRecord[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(rows.map((row) => row.ownerUserId).filter((id): id is string => Boolean(id))),
  ];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(users.map((user) => [user.id, user.name]));
}

function toRow(record: ExceptionRecord, now: Date, names: Map<string, string>): CtExceptionRow {
  const kind = (EXCEPTION_KINDS as readonly string[]).includes(record.kind)
    ? (record.kind as ExceptionKind)
    : 'incident';
  const areaKey = record.areaKey ?? 'administracion';
  const extra = record.extra && typeof record.extra === 'object' ? record.extra : {};
  const incidentKind = typeof extra.incidentKind === 'string' ? extra.incidentKind : null;
  const title =
    kind === 'incident' && incidentKind
      ? record.title ||
        INCIDENT_KIND_LABELS[incidentKind as keyof typeof INCIDENT_KIND_LABELS] ||
        'Incidencia'
      : record.title;
  return {
    id: `${kind}:${record.sourceId}`,
    kind,
    kindLabel: EXCEPTION_KIND_LABELS[kind],
    areaKey,
    areaLabel: isAreaKey(areaKey) ? AREA_LABELS[areaKey] : areaKey,
    caseId: record.caseId,
    caseNumber: record.caseNumber,
    customerName: record.customerName,
    title,
    detail: record.detail,
    status: record.status,
    severity: record.severity,
    severityLabel: SEVERITY_LABELS[record.severity] ?? record.severity,
    ownerUserId: record.ownerUserId,
    ownerName: record.ownerUserId ? (names.get(record.ownerUserId) ?? null) : null,
    dueAt: record.dueAt ? record.dueAt.toISOString() : null,
    since: record.since.toISOString(),
    ageMinutes: Math.max(0, Math.floor((now.getTime() - record.since.getTime()) / 60_000)),
    objectType: record.objectType,
    objectId: record.objectId,
    version: record.version ?? 1,
    extra,
  };
}

/** Página de excepciones, ya filtrada, ordenada y con el conteo por tipo. */
export async function listControlTowerExceptions(
  actor: CurrentUser,
  input: ExceptionQueryInput = {},
  options: { now?: Date } = {}
): Promise<ExceptionsPage> {
  assertControlTowerAccess(actor);
  const now = options.now ?? new Date();
  const query = exceptionQuerySchema.parse(input);
  const union = unionOf(query, now);
  const where = whereClause(query);
  const orderColumn = Prisma.raw(`rows.${SORT_COLUMNS[query.sort as ExceptionSortField]}`);
  const direction = Prisma.raw(query.direction === 'asc' ? 'ASC' : 'DESC');
  const offset = (query.page - 1) * query.page_size;

  const [records, totals, counts] = await Promise.all([
    prisma.$queryRaw<ExceptionRecord[]>(Prisma.sql`
      SELECT rows.* FROM (${union}) AS rows
      ${where}
      ORDER BY ${orderColumn} ${direction} NULLS LAST, rows."since" DESC
      LIMIT ${query.page_size} OFFSET ${offset}
    `),
    prisma.$queryRaw<Array<{ count: bigint | number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS "count" FROM (${union}) AS rows ${where}
    `),
    prisma.$queryRaw<Array<{ kind: string; count: number }>>(Prisma.sql`
      SELECT rows."kind" AS "kind", COUNT(*)::int AS "count"
      FROM (${union}) AS rows ${where}
      GROUP BY 1
    `),
  ]);

  const names = await resolveNames(records);
  const total = Number(totals[0]?.count ?? 0);
  return {
    data: records.map((record) => toRow(record, now, names)),
    pagination: {
      page: query.page,
      page_size: query.page_size,
      total,
      total_pages: Math.max(1, Math.ceil(total / query.page_size)),
    },
    counts: EXCEPTION_KINDS.map((kind) => ({
      kind,
      label: EXCEPTION_KIND_LABELS[kind],
      count: Number(counts.find((row) => row.kind === kind)?.count ?? 0),
    })).filter((row) => row.count > 0 || query.kind.includes(row.kind)),
    computedAt: now.toISOString(),
  };
}
