import { Prisma } from '@prisma/client';
import {
  areaWorkRowSelect,
  type AreaWorkSqlFilters,
  type WorkRowBranch,
} from '@/modules/areas/work-rows-sql';
import type { AreaWorkScope } from '@/modules/areas/work-filters';
import {
  MANUFACTURING_AREA_KEY,
  MANUFACTURING_OBJECT_TYPES,
  OPERATION_STATUS_LABELS,
  PRODUCTION_ORDER_OPEN_STATUSES,
  PRODUCTION_ORDER_STATUS_LABELS,
} from '@/modules/manufacturing/manufacturing-types';
import { OPERATION_ROW_ACTIONS, ORDER_ROW_ACTIONS } from './row-actions';

/**
 * SQL branches of the Manufactura work centre (plan 7.4): production orders and
 * the operations of the floor, as rows of the area UNION.
 *
 * SAFETY: built with `areaWorkRowSelect`, so the 24 canonical columns keep their
 * order and the `UNION ALL` stays valid. Every value written by a person travels
 * as a bound parameter — the action catalogue included, which is sent as one
 * JSON parameter and filtered by status INSIDE SQL, so each row only carries the
 * actions its own state allows.
 */

const ORDER_OPEN = Prisma.sql`o."status" IN (${Prisma.join([...PRODUCTION_ORDER_OPEN_STATUSES])})`;
const OPERATION_LIVE = Prisma.sql`op."status" IN ('pending', 'running', 'paused')`;
const OPERATION_OPEN = Prisma.sql`(${OPERATION_LIVE} AND ${ORDER_OPEN})`;

/** ISO-8601 with the Z suffix: the stored timestamps are UTC. */
const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

function isoText(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`to_char(${column}, ${ISO_FORMAT})`;
}

/** `CASE <column> WHEN 'draft' THEN 'Borrador' … END` with every value bound. */
function labelCase(column: Prisma.Sql, labels: Record<string, string>): Prisma.Sql {
  const entries = Object.entries(labels);
  if (entries.length === 0) return column;
  const whens = entries.map(([key, label]) => Prisma.sql`WHEN ${key}::text THEN ${label}::text`);
  return Prisma.sql`(CASE ${column} ${Prisma.join(whens, ' ')} ELSE ${column} END)`;
}

function scopeCondition(scope: AreaWorkScope, open: Prisma.Sql): Prisma.Sql {
  if (scope === 'open') return Prisma.sql`AND ${open}`;
  if (scope === 'closed') return Prisma.sql`AND NOT (${open})`;
  return Prisma.empty;
}

/**
 * Actions of the row: the catalogue is one bound JSON parameter and the status
 * filter runs in SQL, so nothing a person wrote ever reaches the statement and a
 * row never carries an action its state forbids. The per-row `payload` and
 * `aggregateId` are added here because every manufacturing command asserts that
 * its aggregate matches the id in its payload.
 */
function orderActionsSql(): Prisma.Sql {
  const catalog = JSON.stringify(ORDER_ROW_ACTIONS);
  return Prisma.sql`COALESCE((
    SELECT jsonb_agg(
             entry.value
             || jsonb_build_object('payload', jsonb_build_object('productionOrderId', o."id"))
             ORDER BY entry.ordinality
           )
    FROM jsonb_array_elements(${catalog}::jsonb) WITH ORDINALITY AS entry(value, ordinality)
    WHERE jsonb_exists(entry.value -> 'statuses', o."status")
  ), '[]'::jsonb)`;
}

function operationActionsSql(): Prisma.Sql {
  const catalog = JSON.stringify(OPERATION_ROW_ACTIONS);
  return Prisma.sql`COALESCE((
    SELECT jsonb_agg(
             entry.value
             || jsonb_build_object(
                  'aggregateId', op."productionOrderId",
                  'payload', jsonb_build_object(
                    'productionOrderId', op."productionOrderId",
                    'operationId', op."id"
                  )
                )
             ORDER BY entry.ordinality
           )
    FROM jsonb_array_elements(${catalog}::jsonb) WITH ORDINALITY AS entry(value, ordinality)
    WHERE jsonb_exists(entry.value -> 'statuses', op."status")
      AND jsonb_exists(entry.value -> 'orderStatuses', o."status")
  ), '[]'::jsonb)`;
}

/** Production orders: the row Manufactura works on every day. */
export function productionOrderBranch(): WorkRowBranch {
  return {
    rowKind: 'production_order',
    sql: (filters: AreaWorkSqlFilters) => {
      const caseFilter = filters.caseId
        ? Prisma.sql`AND o."caseId" = ${filters.caseId}`
        : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND o."createdByUserId" = ${filters.ownerUserId}`
        : Prisma.empty;
      return areaWorkRowSelect({
        rowKind: 'production_order',
        from: Prisma.sql`FROM "ProductionOrder" o
          LEFT JOIN "OperationalCase" c ON c."id" = o."caseId"
          LEFT JOIN "WorkCenter" wc ON wc."id" = o."workCenterId"
          LEFT JOIN "Product" pr ON pr."zohoItemId" = o."outputZohoItemId"`,
        where: Prisma.sql`WHERE TRUE ${caseFilter} ${ownerFilter} ${scopeCondition(filters.scope, ORDER_OPEN)}`,
        columns: {
          sourceId: Prisma.sql`o."id"`,
          areaKey: Prisma.sql`${MANUFACTURING_AREA_KEY}::text`,
          caseId: Prisma.sql`o."caseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`o."number" || ' · ' || COALESCE(NULLIF(o."outputName", ''), pr."name", o."outputZohoItemId")`,
          status: Prisma.sql`o."status"`,
          priority: Prisma.sql`o."priority"`,
          ownerUserId: Prisma.sql`o."createdByUserId"`,
          dueAt: Prisma.sql`o."plannedEndAt"`,
          startedAt: Prisma.sql`o."startedAt"`,
          lastActivityAt: Prisma.sql`o."updatedAt"`,
          objectType: Prisma.sql`${MANUFACTURING_OBJECT_TYPES.productionOrder}::text`,
          objectId: Prisma.sql`o."id"`,
          locationCode: Prisma.sql`wc."key"`,
          quantity: Prisma.sql`o."plannedQty"`,
          version: Prisma.sql`o."version"`,
          open: ORDER_OPEN,
          extra: Prisma.sql`jsonb_build_object(
            'workCenter', wc."name",
            'workCenterId', o."workCenterId",
            'plannedEndAt', ${isoText(Prisma.sql`o."plannedEndAt"`)},
            'plannedStartAt', ${isoText(Prisma.sql`o."plannedStartAt"`)},
            'statusLabel', ${labelCase(Prisma.sql`o."status"`, PRODUCTION_ORDER_STATUS_LABELS)},
            'number', o."number",
            'kind', o."kind",
            'outputZohoItemId', o."outputZohoItemId",
            'outputName', COALESCE(NULLIF(o."outputName", ''), pr."name"),
            'plannedQty', o."plannedQty"::text,
            'plannedUnit', o."plannedUnit",
            'producedQty', o."producedQty"::text,
            'scrapQty', o."scrapQty"::text,
            'leftoverQty', o."leftoverQty"::text,
            'releaseTarget', o."releaseTarget",
            'blockedReason', o."blockedReason",
            'actions', ${orderActionsSql()}
          )`,
        },
      });
    },
  };
}

/** Operations of the floor: what each work centre has to start, pause or finish. */
export function productionOperationBranch(): WorkRowBranch {
  return {
    rowKind: 'production_operation',
    sql: (filters: AreaWorkSqlFilters) => {
      const caseFilter = filters.caseId
        ? Prisma.sql`AND o."caseId" = ${filters.caseId}`
        : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND op."assignedUserId" = ${filters.ownerUserId}`
        : Prisma.empty;
      return areaWorkRowSelect({
        rowKind: 'production_operation',
        from: Prisma.sql`FROM "ProductionOperation" op
          JOIN "ProductionOrder" o ON o."id" = op."productionOrderId"
          LEFT JOIN "OperationalCase" c ON c."id" = o."caseId"
          LEFT JOIN "WorkCenter" wc ON wc."id" = op."workCenterId"`,
        where: Prisma.sql`WHERE TRUE ${caseFilter} ${ownerFilter} ${scopeCondition(filters.scope, OPERATION_OPEN)}`,
        columns: {
          sourceId: Prisma.sql`op."id"`,
          areaKey: Prisma.sql`${MANUFACTURING_AREA_KEY}::text`,
          caseId: Prisma.sql`o."caseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`o."number" || ' · ' || op."seq"::text || '. ' || op."name"`,
          status: Prisma.sql`op."status"`,
          priority: Prisma.sql`o."priority"`,
          ownerUserId: Prisma.sql`op."assignedUserId"`,
          dueAt: Prisma.sql`op."plannedStartAt"`,
          startedAt: Prisma.sql`op."startedAt"`,
          lastActivityAt: Prisma.sql`op."updatedAt"`,
          objectType: Prisma.sql`${MANUFACTURING_OBJECT_TYPES.productionOperation}::text`,
          objectId: Prisma.sql`op."id"`,
          locationCode: Prisma.sql`wc."key"`,
          quantity: Prisma.sql`o."plannedQty"`,
          // The optimistic version of an operation IS its order's: every floor
          // command runs against the production order aggregate.
          version: Prisma.sql`o."version"`,
          open: OPERATION_OPEN,
          extra: Prisma.sql`jsonb_build_object(
            'workCenter', wc."name",
            'workCenterId', op."workCenterId",
            'plannedEndAt', ${isoText(Prisma.sql`o."plannedEndAt"`)},
            'plannedStartAt', ${isoText(Prisma.sql`op."plannedStartAt"`)},
            'statusLabel', ${labelCase(Prisma.sql`op."status"`, OPERATION_STATUS_LABELS)},
            'seq', op."seq",
            'operationName', op."name",
            'plannedMinutes', op."plannedMinutes",
            'actualMinutes', op."actualMinutes",
            'productionOrderId', op."productionOrderId",
            'orderNumber', o."number",
            'orderStatus', o."status",
            'orderStatusLabel', ${labelCase(Prisma.sql`o."status"`, PRODUCTION_ORDER_STATUS_LABELS)},
            'actions', ${operationActionsSql()}
          )`,
        },
      });
    },
  };
}

export function manufacturaWorkRowBranches(): WorkRowBranch[] {
  return [productionOrderBranch(), productionOperationBranch()];
}
