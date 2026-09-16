import { Prisma } from '@prisma/client';
import {
  areaWorkRowSelect,
  branchActionsSql,
  type AreaWorkSqlFilters,
  type WorkRowBranch,
} from '@/modules/areas/work-rows-sql';
import type { AreaWorkScope } from '@/modules/areas/work-filters';
import {
  CASE_OPEN_STATUSES,
  CASE_PHASE_LABELS,
  CASE_STATUS_LABELS,
} from '@/modules/operations/types';
import {
  OPPORTUNITY_ROW_STATUS_LABELS,
  QUOTE_CLOSED_STATUSES,
  QUOTE_CLOSED_WINDOW_DAYS,
  QUOTE_OPEN_STATUSES,
  QUOTE_STATUS_LABELS,
  VENTAS_AREA_KEY,
  VENTAS_ROW_KINDS,
} from './ventas-constants';
import { CASE_ROW_ACTIONS, OPPORTUNITY_ROW_ACTIONS, QUOTE_ACTIONS_NOTE } from './row-actions';

/**
 * Ramas del centro de trabajo de Ventas (plan 7.4): expedientes de venta,
 * oportunidades del embudo y cotizaciones de Zoho enviadas o por vencer. Las
 * solicitudes recibidas y enviadas y los work items los aporta el núcleo.
 *
 * SEGURIDAD: todo valor escrito por una persona entra como parámetro (`${…}`);
 * aquí no se concatena texto de nadie. Las etiquetas en español se arman con
 * `CASE … WHEN` cuyos literales también viajan como parámetros, así que el SQL
 * es constante.
 */

const CASE_KIND = 'sales_fulfillment';
const DAY_MS = 86_400_000;

function scopeCondition(scope: AreaWorkScope, open: Prisma.Sql): Prisma.Sql {
  if (scope === 'open') return Prisma.sql`AND ${open}`;
  if (scope === 'closed') return Prisma.sql`AND NOT (${open})`;
  return Prisma.empty;
}

/** `CASE col WHEN 'open' THEN 'Abierto' … ELSE col END`, con los literales como parámetros. */
function labelCase(column: Prisma.Sql, labels: Readonly<Record<string, string>>): Prisma.Sql {
  const whens = Object.entries(labels).map(([key, label]) => Prisma.sql`WHEN ${key} THEN ${label}`);
  if (whens.length === 0) return column;
  return Prisma.sql`CASE ${column} ${Prisma.join(whens, ' ')} ELSE ${column} END`;
}

// ---------------------------------------------------------------------------
// Expedientes de venta
// ---------------------------------------------------------------------------

function caseBranch(): WorkRowBranch {
  return {
    rowKind: VENTAS_ROW_KINDS.case,
    sql: (filters: AreaWorkSqlFilters) => {
      const open = Prisma.sql`c."status" IN (${Prisma.join([...CASE_OPEN_STATUSES])})`;
      const caseFilter = filters.caseId ? Prisma.sql`AND c."id" = ${filters.caseId}` : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND c."ownerUserId" = ${filters.ownerUserId}`
        : Prisma.empty;
      return areaWorkRowSelect({
        rowKind: VENTAS_ROW_KINDS.case,
        from: Prisma.sql`FROM "OperationalCase" c`,
        where: Prisma.sql`WHERE c."kind" = ${CASE_KIND} ${caseFilter} ${ownerFilter} ${scopeCondition(filters.scope, open)}`,
        columns: {
          sourceId: Prisma.sql`c."id"`,
          areaKey: Prisma.sql`${VENTAS_AREA_KEY}::text`,
          caseId: Prisma.sql`c."id"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`COALESCE(NULLIF(c."salesOrderNumber", ''), c."caseNumber")`,
          status: Prisma.sql`c."status"`,
          priority: Prisma.sql`c."priority"`,
          ownerUserId: Prisma.sql`c."ownerUserId"`,
          dueAt: Prisma.sql`c."promisedAt"`,
          startedAt: Prisma.sql`c."openedAt"`,
          lastActivityAt: Prisma.sql`c."lastActivityAt"`,
          objectType: Prisma.sql`${'operational_case'}::text`,
          objectId: Prisma.sql`c."id"`,
          counterpartyName: Prisma.sql`c."salespersonName"`,
          locationCode: Prisma.sql`c."locationName"`,
          version: Prisma.sql`c."version"`,
          open,
          extra: Prisma.sql`jsonb_build_object(
            'statusLabel', ${labelCase(Prisma.sql`c."status"`, CASE_STATUS_LABELS)},
            'phase', ${labelCase(Prisma.sql`c."phase"`, CASE_PHASE_LABELS)},
            'phaseKey', c."phase",
            'promisedAt', c."promisedAt",
            'salesOrderNumber', c."salesOrderNumber",
            'zohoSalesOrderId', c."zohoSalesOrderId",
            'salesOrderId', CASE WHEN c."sourceType" = ${'sales_order'} THEN c."sourceId" END,
            'salespersonName', c."salespersonName",
            'closeReason', c."closeReason",
            'actions', ${branchActionsSql({
              catalog: CASE_ROW_ACTIONS,
              status: Prisma.sql`c."status"`,
              // `case.advance` y `case.cancel` declaran su esquema `.strict()`:
              // sólo viaja lo que escribe la persona, ningún id extra.
              payload: Prisma.sql`'{}'::jsonb`,
            })}
          )`,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Oportunidades
// ---------------------------------------------------------------------------

const OPPORTUNITY_LIVE_STATUSES = ['open', 'dormant'] as const;

function opportunityBranch(): WorkRowBranch {
  return {
    rowKind: VENTAS_ROW_KINDS.opportunity,
    sql: (filters: AreaWorkSqlFilters) => {
      const open = Prisma.sql`o."status" IN (${Prisma.join([...OPPORTUNITY_LIVE_STATUSES])})`;
      // Una oportunidad se liga a un expediente por `caseIds`.
      const caseFilter = filters.caseId
        ? Prisma.sql`AND ${filters.caseId} = ANY(o."caseIds")`
        : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND o."salespersonUserId" = ${filters.ownerUserId}`
        : Prisma.empty;
      return areaWorkRowSelect({
        rowKind: VENTAS_ROW_KINDS.opportunity,
        from: Prisma.sql`FROM "Opportunity" o LEFT JOIN "PipelineStage" s ON s."id" = o."stageId"`,
        where: Prisma.sql`WHERE TRUE ${caseFilter} ${ownerFilter} ${scopeCondition(filters.scope, open)}`,
        columns: {
          sourceId: Prisma.sql`o."id"`,
          areaKey: Prisma.sql`${VENTAS_AREA_KEY}::text`,
          caseId: Prisma.sql`CASE WHEN array_length(o."caseIds", 1) > 0 THEN o."caseIds"[1] END`,
          customerName: Prisma.sql`o."contactName"`,
          title: Prisma.sql`o."title"`,
          status: Prisma.sql`o."status"`,
          ownerUserId: Prisma.sql`o."salespersonUserId"`,
          dueAt: Prisma.sql`o."nextActionAt"`,
          startedAt: Prisma.sql`o."stageEnteredAt"`,
          lastActivityAt: Prisma.sql`o."lastActivityAt"`,
          objectType: Prisma.sql`${'opportunity'}::text`,
          objectId: Prisma.sql`o."id"`,
          counterpartyName: Prisma.sql`s."name"`,
          amount: Prisma.sql`o."estimatedValue"`,
          version: Prisma.sql`o."version"`,
          open,
          extra: Prisma.sql`jsonb_build_object(
            'statusLabel', ${labelCase(Prisma.sql`o."status"`, OPPORTUNITY_ROW_STATUS_LABELS)},
            'number', o."number",
            'stageName', s."name",
            'stageKey', s."key",
            'stageKind', s."kind",
            'nextActionText', o."nextActionText",
            'probability', o."probability",
            'currency', o."currency",
            'source', o."source",
            'zohoContactId', o."zohoContactId",
            'commContactId', o."commContactId",
            'conversationId', CASE WHEN array_length(o."conversationIds", 1) > 0
              THEN o."conversationIds"[array_length(o."conversationIds", 1)] END,
            'quoteCount', COALESCE(array_length(o."zohoEstimateIds", 1), 0),
            'salesOrderCount', COALESCE(array_length(o."zohoSalesOrderIds", 1), 0),
            'caseCount', COALESCE(array_length(o."caseIds", 1), 0),
            'lostReason', o."lostReason",
            'actions', ${branchActionsSql({
              catalog: OPPORTUNITY_ROW_ACTIONS,
              status: Prisma.sql`o."status"`,
              payload: Prisma.sql`jsonb_build_object('opportunityId', o."id")`,
            })}
          )`,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Cotizaciones de Zoho
// ---------------------------------------------------------------------------

function quoteBranch(): WorkRowBranch {
  return {
    rowKind: VENTAS_ROW_KINDS.quote,
    sql: (filters: AreaWorkSqlFilters) => {
      const open = Prisma.sql`COALESCE(q."status", '') IN (${Prisma.join([...QUOTE_OPEN_STATUSES])})`;
      const since = new Date(filters.now.getTime() - QUOTE_CLOSED_WINDOW_DAYS * DAY_MS);
      // Una cotización no pertenece a un expediente: con ese filtro la rama no aporta filas.
      const caseFilter = filters.caseId ? Prisma.sql`AND FALSE` : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND q."createdByUserId" = ${filters.ownerUserId}`
        : Prisma.empty;
      const visible = Prisma.sql`(${open} OR (COALESCE(q."status", '') IN (${Prisma.join([...QUOTE_CLOSED_STATUSES])}) AND COALESCE(q."date", q."createdAt") >= ${since}))`;
      const convertible = Prisma.sql`(q."status" = ${'accepted'} AND NOT EXISTS (
        SELECT 1 FROM "SalesOrderWriteRequest" w WHERE w."quoteId" = q."id" AND w."status" = ${'completed'}
      ))`;
      return areaWorkRowSelect({
        rowKind: VENTAS_ROW_KINDS.quote,
        from: Prisma.sql`FROM "Quote" q`,
        where: Prisma.sql`WHERE ${visible} ${caseFilter} ${ownerFilter} ${scopeCondition(filters.scope, open)}`,
        columns: {
          sourceId: Prisma.sql`q."id"`,
          areaKey: Prisma.sql`${VENTAS_AREA_KEY}::text`,
          customerName: Prisma.sql`q."customerName"`,
          title: Prisma.sql`${'Cotización '}::text || COALESCE(NULLIF(q."estimateNumber", ''), q."zohoEstimateId")`,
          status: Prisma.sql`COALESCE(q."status", ${'draft'})`,
          ownerUserId: Prisma.sql`q."createdByUserId"`,
          dueAt: Prisma.sql`q."expiryDate"`,
          lastActivityAt: Prisma.sql`COALESCE(q."zohoLastModifiedTime", q."updatedAt")`,
          objectType: Prisma.sql`${'quote'}::text`,
          objectId: Prisma.sql`q."id"`,
          counterpartyName: Prisma.sql`q."salespersonName"`,
          amount: Prisma.sql`q."total"`,
          open,
          extra: Prisma.sql`jsonb_build_object(
            'statusLabel', ${labelCase(Prisma.sql`COALESCE(q."status", ${'draft'})`, QUOTE_STATUS_LABELS)},
            'estimateNumber', COALESCE(NULLIF(q."estimateNumber", ''), q."zohoEstimateId"),
            'zohoEstimateId', q."zohoEstimateId",
            'zohoCustomerId', q."zohoCustomerId",
            'currency', q."currencyCode",
            'viewedByClient', COALESCE(q."isViewedByClient", false),
            'expiryDate', q."expiryDate",
            'acceptedDate', q."acceptedDate",
            'convertible', ${convertible},
            'createdInUnik', q."createdInUnik",
            'salespersonName', q."salespersonName",
            'actions', '[]'::jsonb,
            'actionsNote', ${QUOTE_ACTIONS_NOTE}::text
          )`,
        },
      });
    },
  };
}

/** Ramas propias de Ventas, en el orden de los chips del centro de trabajo. */
export function ventasWorkRowBranches(): WorkRowBranch[] {
  return [caseBranch(), opportunityBranch(), quoteBranch()];
}
