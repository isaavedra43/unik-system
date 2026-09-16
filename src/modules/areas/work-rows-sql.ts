import { Prisma } from '@prisma/client';
import { AREA_REQUEST_OPEN_STATUSES, WORK_ITEM_OPEN_STATUSES } from '@/modules/operations/types';
import type { AreaMeta } from './area-registry';
import { areaWorkFieldTypes, areaWorkFilterableFields, extraFieldKey } from './work-columns';
import {
  AreaWorkQueryError,
  type AreaWorkFilterRule,
  type AreaWorkQueryState,
  type AreaWorkScope,
} from './work-filters';

/**
 * SQL of the area work rows (plan 7.4 and 13: `$queryRaw` parameterizado, sin
 * vistas ni preview features). Every branch produces the SAME column list and
 * they are joined with `UNION ALL`; filters, search, sorting and pagination are
 * applied once on top of the union.
 *
 * SAFETY RULES, enforced by the unit test:
 * - every value written by a person travels as a bound parameter (`${value}`);
 * - the only identifiers that reach `Prisma.raw` are column names already
 *   validated against the area's own column registry (`work-columns.ts`) and
 *   re-checked against `/^[A-Za-z][A-Za-z0-9_]*$/`;
 * - values of the extra columns are read as `rows."extra" ->> $n`, where the
 *   JSON key is itself a bound parameter.
 */

// ---------------------------------------------------------------------------
// Canonical columns
// ---------------------------------------------------------------------------

export const AREA_WORK_ROW_COLUMNS = [
  'rowKind',
  'sourceId',
  'areaKey',
  'caseId',
  'caseNumber',
  'customerName',
  'title',
  'status',
  'priority',
  'ownerUserId',
  'dueAt',
  'startedAt',
  'lastActivityAt',
  'escalationLevel',
  'waitReason',
  'objectType',
  'objectId',
  'counterpartyName',
  'locationCode',
  'amount',
  'quantity',
  'version',
  'open',
  'extra',
] as const;

export type AreaWorkRowColumn = (typeof AREA_WORK_ROW_COLUMNS)[number];

/** Default expression per column, so a branch only writes what it actually has. */
const COLUMN_DEFAULTS: Record<AreaWorkRowColumn, Prisma.Sql> = {
  rowKind: Prisma.sql`NULL::text`,
  sourceId: Prisma.sql`NULL::text`,
  areaKey: Prisma.sql`NULL::text`,
  caseId: Prisma.sql`NULL::text`,
  caseNumber: Prisma.sql`NULL::text`,
  customerName: Prisma.sql`NULL::text`,
  title: Prisma.sql`''::text`,
  status: Prisma.sql`''::text`,
  priority: Prisma.sql`'normal'::text`,
  ownerUserId: Prisma.sql`NULL::text`,
  dueAt: Prisma.sql`NULL::timestamp`,
  startedAt: Prisma.sql`NULL::timestamp`,
  lastActivityAt: Prisma.sql`now()::timestamp`,
  escalationLevel: Prisma.sql`0::int`,
  waitReason: Prisma.sql`NULL::text`,
  objectType: Prisma.sql`NULL::text`,
  objectId: Prisma.sql`NULL::text`,
  counterpartyName: Prisma.sql`NULL::text`,
  locationCode: Prisma.sql`NULL::text`,
  amount: Prisma.sql`NULL::numeric`,
  quantity: Prisma.sql`NULL::numeric`,
  version: Prisma.sql`1::int`,
  open: Prisma.sql`TRUE`,
  extra: Prisma.sql`'{}'::jsonb`,
};

/** Shape the database returns for one row of the union. */
export interface AreaWorkRowRecord {
  rowKind: string;
  sourceId: string;
  areaKey: string | null;
  caseId: string | null;
  caseNumber: string | null;
  customerName: string | null;
  title: string;
  status: string;
  priority: string | null;
  ownerUserId: string | null;
  dueAt: Date | null;
  startedAt: Date | null;
  lastActivityAt: Date;
  escalationLevel: number;
  waitReason: string | null;
  objectType: string | null;
  objectId: string | null;
  counterpartyName: string | null;
  locationCode: string | null;
  amount: Prisma.Decimal | string | null;
  quantity: Prisma.Decimal | string | null;
  version: number;
  open: boolean;
  extra: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export interface AreaWorkSqlFilters {
  areaKey: string;
  scope: AreaWorkScope;
  caseId?: string;
  /** Rows of one person (owner or backup); pushed down when the branch can. */
  ownerUserId?: string;
  now: Date;
}

export interface WorkRowBranch {
  rowKind: string;
  /** SELECT with the canonical columns for this row kind. */
  sql: (filters: AreaWorkSqlFilters) => Prisma.Sql;
}

/**
 * Builds a branch SELECT: fills the missing columns with their defaults and
 * keeps the canonical order, which is what makes the `UNION ALL` valid.
 */
export function areaWorkRowSelect(input: {
  rowKind: string;
  from: Prisma.Sql;
  where: Prisma.Sql;
  columns: Partial<Record<AreaWorkRowColumn, Prisma.Sql>>;
}): Prisma.Sql {
  const selected = AREA_WORK_ROW_COLUMNS.map((name) => {
    const expression =
      name === 'rowKind'
        ? Prisma.sql`${input.rowKind}::text`
        : (input.columns[name] ?? COLUMN_DEFAULTS[name]);
    return Prisma.sql`${expression} AS ${Prisma.raw(`"${name}"`)}`;
  });
  return Prisma.sql`SELECT ${Prisma.join(selected, ', ')} ${input.from} ${input.where}`;
}

// ---------------------------------------------------------------------------
// Domain actions of a branch (`extra.actions`)
// ---------------------------------------------------------------------------

/** Minimum an action catalogue needs to be filtered by state inside Postgres. */
export interface BranchActionCatalogEntry {
  id: string;
  /** States of the row itself in which the action is offered. */
  statuses: readonly string[];
}

/**
 * Acciones de dominio de la fila (plan 7.4), UNA sola implementación para todas
 * las áreas. El catálogo viaja como UN parámetro ligado y el filtro por estado
 * corre DENTRO de Postgres, así que nada que haya escrito una persona llega a la
 * sentencia y una fila nunca carga una acción que su estado prohíbe.
 *
 * `payload` es el id del registro sobre el que actúa el comando (cada manejador
 * comprueba que el agregado corresponda a ese id) y se fusiona con el payload
 * fijo que el catálogo ya traía. `conditions` añade la regla de negocio de una
 * acción concreta (que la orden tenga partidas, que la cotización tenga
 * respuestas) para no ofrecer un botón que el motor iba a rechazar.
 *
 * Lo que sale de aquí lo vuelve a validar `work-actions.parseBranchActions`
 * antes de mostrarse, y `executeCommand` valida otra vez permiso, transición y
 * versión: ocultar un botón es sólo una cortesía.
 */
export function branchActionsSql(input: {
  catalog: readonly BranchActionCatalogEntry[];
  status: Prisma.Sql;
  payload: Prisma.Sql;
  aggregateId?: Prisma.Sql;
  conditions?: Record<string, Prisma.Sql>;
}): Prisma.Sql {
  const conditions = Object.entries(input.conditions ?? {}).map(
    ([id, condition]) => Prisma.sql`AND (entry.value ->> 'id' <> ${id} OR (${condition}))`
  );
  const aggregate = input.aggregateId
    ? Prisma.sql`|| jsonb_build_object('aggregateId', ${input.aggregateId})`
    : Prisma.empty;
  return Prisma.sql`COALESCE((
    SELECT jsonb_agg(
             entry.value
             || jsonb_build_object(
                  'payload',
                  COALESCE(entry.value -> 'payload', '{}'::jsonb) || ${input.payload}
                )
             ${aggregate}
             ORDER BY entry.ordinality
           )
    FROM jsonb_array_elements(${JSON.stringify(input.catalog)}::jsonb)
      WITH ORDINALITY AS entry(value, ordinality)
    WHERE jsonb_exists(entry.value -> 'statuses', ${input.status})
    ${conditions.length > 0 ? Prisma.join(conditions, ' ') : Prisma.empty}
  ), '[]'::jsonb)`;
}

const WORK_ITEM_OPEN = Prisma.sql`w."status" IN (${Prisma.join([...WORK_ITEM_OPEN_STATUSES])})`;
const REQUEST_OPEN = Prisma.sql`r."status" IN (${Prisma.join([...AREA_REQUEST_OPEN_STATUSES])})`;

function scopeCondition(scope: AreaWorkScope, open: Prisma.Sql): Prisma.Sql {
  if (scope === 'open') return Prisma.sql`AND ${open}`;
  if (scope === 'closed') return Prisma.sql`AND NOT (${open})`;
  return Prisma.empty;
}

/** Work items of the area: the branch every area has. */
export function workItemBranch(): WorkRowBranch {
  return {
    rowKind: 'work_item',
    sql: (filters) => {
      const caseFilter = filters.caseId
        ? Prisma.sql`AND w."caseId" = ${filters.caseId}`
        : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND (w."ownerUserId" = ${filters.ownerUserId} OR w."backupUserId" = ${filters.ownerUserId})`
        : Prisma.empty;
      return areaWorkRowSelect({
        rowKind: 'work_item',
        from: Prisma.sql`FROM "WorkItem" w LEFT JOIN "OperationalCase" c ON c."id" = w."caseId"`,
        where: Prisma.sql`WHERE w."areaKey" = ${filters.areaKey} ${caseFilter} ${ownerFilter} ${scopeCondition(filters.scope, WORK_ITEM_OPEN)}`,
        columns: {
          sourceId: Prisma.sql`w."id"`,
          areaKey: Prisma.sql`w."areaKey"`,
          caseId: Prisma.sql`w."caseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`w."title"`,
          status: Prisma.sql`w."status"`,
          priority: Prisma.sql`COALESCE(c."priority", 'normal')`,
          ownerUserId: Prisma.sql`w."ownerUserId"`,
          dueAt: Prisma.sql`w."dueAt"`,
          startedAt: Prisma.sql`CASE WHEN w."status" = 'in_progress' THEN w."updatedAt" END`,
          lastActivityAt: Prisma.sql`w."updatedAt"`,
          escalationLevel: Prisma.sql`w."escalationLevel"`,
          waitReason: Prisma.sql`w."waitReason"`,
          objectType: Prisma.sql`w."objectType"`,
          objectId: Prisma.sql`w."objectId"`,
          version: Prisma.sql`w."version"`,
          open: WORK_ITEM_OPEN,
          extra: Prisma.sql`jsonb_build_object(
            'kind', w."kind",
            'description', w."description",
            'backupUserId', w."backupUserId",
            'waitUntil', w."waitUntil",
            'stepId', w."stepId",
            'requiredEvidence', to_jsonb(w."requiredEvidence"),
            'salesOrderNumber', c."salesOrderNumber",
            'phase', c."phase"
          )`,
        },
      });
    },
  };
}

function requestBranch(rowKind: 'request_in' | 'request_out'): WorkRowBranch {
  const incoming = rowKind === 'request_in';
  return {
    rowKind,
    sql: (filters) => {
      const direction = incoming
        ? Prisma.sql`r."toAreaKey" = ${filters.areaKey}`
        : Prisma.sql`r."fromAreaKey" = ${filters.areaKey} AND r."toAreaKey" <> ${filters.areaKey}`;
      const caseFilter = filters.caseId
        ? Prisma.sql`AND r."caseId" = ${filters.caseId}`
        : Prisma.empty;
      const ownerFilter =
        filters.ownerUserId && incoming
          ? Prisma.sql`AND (r."ownerUserId" = ${filters.ownerUserId} OR r."backupUserId" = ${filters.ownerUserId})`
          : filters.ownerUserId
            ? Prisma.sql`AND r."createdById" = ${filters.ownerUserId}`
            : Prisma.empty;
      return areaWorkRowSelect({
        rowKind,
        from: Prisma.sql`FROM "AreaRequest" r LEFT JOIN "OperationalCase" c ON c."id" = r."caseId"`,
        where: Prisma.sql`WHERE ${direction} ${caseFilter} ${ownerFilter} ${scopeCondition(filters.scope, REQUEST_OPEN)}`,
        columns: {
          sourceId: Prisma.sql`r."id"`,
          areaKey: Prisma.sql`${filters.areaKey}::text`,
          caseId: Prisma.sql`r."caseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`r."title"`,
          status: Prisma.sql`r."status"`,
          priority: Prisma.sql`r."priority"`,
          ownerUserId: Prisma.sql`r."ownerUserId"`,
          dueAt: Prisma.sql`r."dueAt"`,
          lastActivityAt: Prisma.sql`r."updatedAt"`,
          objectType: Prisma.sql`r."objectType"`,
          objectId: Prisma.sql`r."objectId"`,
          counterpartyName: incoming ? Prisma.sql`r."fromAreaKey"` : Prisma.sql`r."toAreaKey"`,
          version: Prisma.sql`r."version"`,
          open: REQUEST_OPEN,
          extra: Prisma.sql`jsonb_build_object(
            'kind', r."kind",
            'fromAreaKey', r."fromAreaKey",
            'toAreaKey', r."toAreaKey",
            'blocksDelivery', r."blocksDelivery",
            'freeText', r."freeText",
            'backupUserId', r."backupUserId",
            'workItemId', r."workItemId",
            'createdByType', r."createdByType",
            'createdById', r."createdById",
            'chatMessageId', r."chatMessageId",
            'answeredAt', r."answeredAt"
          )`,
        },
      });
    },
  };
}

/** Branches every area gets for free: its work items and the requests it received and sent. */
export function commonWorkRowBranches(): WorkRowBranch[] {
  return [workItemBranch(), requestBranch('request_in'), requestBranch('request_out')];
}

// ---------------------------------------------------------------------------
// Filters over the union
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

type FieldType = 'text' | 'date' | 'number' | 'currency' | 'status' | 'boolean';

/** Column expression: a real column of the union, or a key of its `extra` JSON. */
function fieldExpression(field: string, type: FieldType): Prisma.Sql {
  const extraKey = extraFieldKey(field);
  const base = extraKey
    ? Prisma.sql`(rows."extra" ->> ${extraKey})`
    : (() => {
        if (!IDENTIFIER.test(field)) {
          throw new AreaWorkQueryError(`Columna inválida: ${field}`);
        }
        return Prisma.sql`rows.${Prisma.raw(`"${field}"`)}`;
      })();
  if (type === 'date') return Prisma.sql`(${base})::timestamptz`;
  if (type === 'number' || type === 'currency') return Prisma.sql`(${base})::numeric`;
  if (type === 'boolean') return Prisma.sql`(${base})::boolean`;
  return Prisma.sql`(${base})::text`;
}

/** `%`, `_` and `\` typed by a person are literal text, never wildcards. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function toIsoDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Range of a date shortcut in the browser-independent server time. */
export function dateShortcutRange(shortcut: string, now: Date): { from: Date; to: Date } | null {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const endOfDay = (date: Date) => {
    const value = new Date(date);
    value.setHours(23, 59, 59, 999);
    return value;
  };
  switch (shortcut) {
    case 'today':
      return { from: start, to: endOfDay(start) };
    case 'yesterday': {
      const from = new Date(start);
      from.setDate(from.getDate() - 1);
      return { from, to: endOfDay(from) };
    }
    case 'this_week': {
      const from = new Date(start);
      const weekday = (from.getDay() + 6) % 7; // Monday = 0
      from.setDate(from.getDate() - weekday);
      const to = new Date(from);
      to.setDate(to.getDate() + 6);
      return { from, to: endOfDay(to) };
    }
    case 'this_month': {
      const from = new Date(start.getFullYear(), start.getMonth(), 1);
      const to = new Date(start.getFullYear(), start.getMonth() + 1, 0);
      return { from, to: endOfDay(to) };
    }
    case 'last_7_days': {
      const from = new Date(start);
      from.setDate(from.getDate() - 6);
      return { from, to: endOfDay(start) };
    }
    case 'last_30_days': {
      const from = new Date(start);
      from.setDate(from.getDate() - 29);
      return { from, to: endOfDay(start) };
    }
    default:
      return null;
  }
}

function ruleCondition(rule: AreaWorkFilterRule, type: FieldType, now: Date): Prisma.Sql | null {
  const expr = fieldExpression(rule.field, type);

  if (rule.operator === 'is_empty') {
    return Prisma.sql`(${expr} IS NULL OR ${fieldExpression(rule.field, 'text')} = '')`;
  }
  if (rule.operator === 'is_not_empty') {
    return Prisma.sql`(${expr} IS NOT NULL AND ${fieldExpression(rule.field, 'text')} <> '')`;
  }

  if (type === 'date') {
    const range = rule.shortcut ? dateShortcutRange(rule.shortcut, now) : null;
    if (range) return Prisma.sql`(${expr} >= ${range.from} AND ${expr} <= ${range.to})`;
    const from = toIsoDate(rule.value);
    const to = toIsoDate(rule.valueTo);
    if (rule.operator === 'between') {
      if (!from || !to) return null;
      return Prisma.sql`(${expr} >= ${from}::timestamptz AND ${expr} <= ${to}::timestamptz)`;
    }
    if (!from) return null;
    if (rule.operator === 'before') return Prisma.sql`${expr} < ${from}::timestamptz`;
    if (rule.operator === 'after') return Prisma.sql`${expr} > ${from}::timestamptz`;
    if (rule.operator === 'equals')
      return Prisma.sql`(${expr})::date = (${from}::timestamptz)::date`;
    if (rule.operator === 'not_equals') {
      return Prisma.sql`(${expr} IS NULL OR (${expr})::date <> (${from}::timestamptz)::date)`;
    }
    return null;
  }

  if (type === 'number' || type === 'currency') {
    const value = toNumber(rule.value);
    const valueTo = toNumber(rule.valueTo);
    if (rule.operator === 'between') {
      if (value === null || valueTo === null) return null;
      return Prisma.sql`(${expr} >= ${value} AND ${expr} <= ${valueTo})`;
    }
    if (value === null) return null;
    switch (rule.operator) {
      case 'equals':
        return Prisma.sql`${expr} = ${value}`;
      case 'not_equals':
        return Prisma.sql`(${expr} IS NULL OR ${expr} <> ${value})`;
      case 'greater_than':
        return Prisma.sql`${expr} > ${value}`;
      case 'greater_or_equal':
        return Prisma.sql`${expr} >= ${value}`;
      case 'less_than':
        return Prisma.sql`${expr} < ${value}`;
      case 'less_or_equal':
        return Prisma.sql`${expr} <= ${value}`;
      default:
        return null;
    }
  }

  if (type === 'boolean') {
    const value =
      rule.value === true || rule.value === 'true'
        ? true
        : rule.value === false || rule.value === 'false'
          ? false
          : null;
    if (value === null) return null;
    return Prisma.sql`${expr} = ${value}`;
  }

  // text / status
  const list = Array.isArray(rule.value)
    ? rule.value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  if (rule.operator === 'in' || rule.operator === 'not_in') {
    if (list.length === 0) return null;
    const inList = Prisma.sql`${expr} IN (${Prisma.join(list)})`;
    return rule.operator === 'in' ? inList : Prisma.sql`(${expr} IS NULL OR NOT (${inList}))`;
  }
  const raw = typeof rule.value === 'string' ? rule.value : list[0];
  if (raw === undefined || raw === '') return null;
  switch (rule.operator) {
    case 'contains':
      return Prisma.sql`${expr} ILIKE ${`%${escapeLike(raw)}%`}`;
    case 'not_contains':
      return Prisma.sql`(${expr} IS NULL OR ${expr} NOT ILIKE ${`%${escapeLike(raw)}%`})`;
    case 'starts_with':
      return Prisma.sql`${expr} ILIKE ${`${escapeLike(raw)}%`}`;
    case 'equals':
      return Prisma.sql`${expr} = ${raw}`;
    case 'not_equals':
      return Prisma.sql`(${expr} IS NULL OR ${expr} <> ${raw})`;
    default:
      return null;
  }
}

const SEARCH_FIELDS = ['title', 'caseNumber', 'customerName', 'counterpartyName'] as const;

function searchCondition(term: string): Prisma.Sql {
  const pattern = `%${escapeLike(term)}%`;
  const parts = SEARCH_FIELDS.map(
    (field) => Prisma.sql`rows.${Prisma.raw(`"${field}"`)} ILIKE ${pattern}`
  );
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

// ---------------------------------------------------------------------------
// Whole query
// ---------------------------------------------------------------------------

export interface AreaWorkSqlResult {
  /** Page of rows, already ordered and paginated. */
  rows: Prisma.Sql;
  /** Total of the same filter (one `count(*)`). */
  count: Prisma.Sql;
}

/**
 * Union of the branches plus filters, sorting and pagination. `branches` are
 * the common ones plus whatever the area registered; a query naming a row kind
 * with no branch simply returns nothing for it.
 */
export function buildAreaWorkRowsSql(input: {
  area: AreaMeta;
  branches: readonly WorkRowBranch[];
  query: AreaWorkQueryState;
  now: Date;
}): AreaWorkSqlResult {
  const { area, query, now } = input;
  const kinds = new Set(query.kind);
  const branches = input.branches.filter((branch) => kinds.size === 0 || kinds.has(branch.rowKind));
  if (branches.length === 0) {
    // No branch answers this filter: a query that returns nothing, still valid SQL.
    const empty = Prisma.sql`SELECT 1 WHERE FALSE`;
    return {
      rows: empty,
      count: Prisma.sql`SELECT 0::int AS "count"`,
    };
  }

  const filters: AreaWorkSqlFilters = {
    areaKey: area.key,
    scope: query.scope,
    now,
    ...(query.caseId ? { caseId: query.caseId } : {}),
    ...(query.ownerUserId ? { ownerUserId: query.ownerUserId } : {}),
  };

  const union = Prisma.join(
    branches.map((branch) => branch.sql(filters)),
    ' UNION ALL '
  );

  const conditions: Prisma.Sql[] = [];
  if (query.scope === 'open') conditions.push(Prisma.sql`rows."open" = TRUE`);
  if (query.scope === 'closed') conditions.push(Prisma.sql`rows."open" = FALSE`);
  if (kinds.size > 0) conditions.push(Prisma.sql`rows."rowKind" IN (${Prisma.join([...kinds])})`);
  if (query.caseId) conditions.push(Prisma.sql`rows."caseId" = ${query.caseId}`);
  if (query.ownerUserId) {
    conditions.push(
      Prisma.sql`(rows."ownerUserId" = ${query.ownerUserId} OR rows."extra" ->> 'backupUserId' = ${query.ownerUserId})`
    );
  }
  if (query.overdueOnly) {
    conditions.push(
      Prisma.sql`(rows."open" = TRUE AND rows."dueAt" IS NOT NULL AND rows."dueAt" < ${now})`
    );
  }
  const search = query.search?.trim();
  if (search) conditions.push(searchCondition(search));

  const filterable = areaWorkFilterableFields(area);
  const types = areaWorkFieldTypes(area);
  const ruleConditions: Prisma.Sql[] = [];
  for (const rule of query.filters.rules) {
    if (!filterable.has(rule.field)) {
      throw new AreaWorkQueryError(`No se puede filtrar por "${rule.field}" en ${area.label}`);
    }
    const condition = ruleCondition(rule, (types[rule.field] ?? 'text') as FieldType, now);
    if (condition) ruleConditions.push(condition);
  }
  if (ruleConditions.length > 0) {
    const joiner = query.filters.logic === 'OR' ? ' OR ' : ' AND ';
    conditions.push(Prisma.sql`(${Prisma.join(ruleConditions, joiner)})`);
  }

  const where =
    conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
  const from = Prisma.sql`FROM (${union}) AS rows ${where}`;

  const sortParts: Prisma.Sql[] = [];
  for (const sort of query.sort.slice(0, 3)) {
    if (!filterableOrSortable(area, sort.field)) {
      throw new AreaWorkQueryError(`No se puede ordenar por "${sort.field}" en ${area.label}`);
    }
    const expr = fieldExpression(sort.field, (types[sort.field] ?? 'text') as FieldType);
    const direction = Prisma.raw(sort.direction === 'asc' ? 'ASC' : 'DESC');
    sortParts.push(Prisma.sql`${expr} ${direction} NULLS LAST`);
  }
  // Stable tiebreaker: two rows never swap places between pages.
  sortParts.push(Prisma.sql`rows."rowKind" ASC`, Prisma.sql`rows."sourceId" ASC`);
  const orderBy = Prisma.sql`ORDER BY ${Prisma.join(sortParts, ', ')}`;

  const take = query.page_size;
  const skip = (query.page - 1) * query.page_size;

  return {
    rows: Prisma.sql`SELECT rows.* ${from} ${orderBy} LIMIT ${take} OFFSET ${skip}`,
    count: Prisma.sql`SELECT count(*)::int AS "count" ${from}`,
  };
}

function filterableOrSortable(area: AreaMeta, field: string): boolean {
  const types = areaWorkFieldTypes(area);
  return Object.prototype.hasOwnProperty.call(types, field);
}
