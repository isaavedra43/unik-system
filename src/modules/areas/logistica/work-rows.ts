import { Prisma } from '@prisma/client';
import {
  DELIVERY_MODE_LABELS,
  DELIVERY_ORDER_OPEN_STATUSES,
  DELIVERY_ORDER_STATUS_LABELS,
  LOGISTICS_COMMANDS,
  LOGISTICS_OBJECT_TYPES,
  TRIP_ACTIVE_STATUSES,
  TRIP_STATUS_LABELS,
} from '@/modules/logistics/types';
import { areaWorkRowSelect, type AreaWorkSqlFilters, type WorkRowBranch } from '../work-rows-sql';

/**
 * Work rows of Logística (plan 7.4): its delivery orders and its trips, added
 * to the common branches (work items and area requests) by the server registry.
 *
 * SAFETY: every value written by a person travels as a bound parameter; the
 * only literals in the query text are column names of the tables above and the
 * labels of this module (constants, never user input). The unit test walks it.
 *
 * Domain actions: a trip offers `trip.start`, `trip.close` and `trip.cancel`,
 * whose aggregate is the trip itself and whose payload is empty (only the
 * cancellation asks for a reason), so they run from the table with the shared
 * dialog. Every delivery command needs its own fields
 * (transportista, fecha, cantidades, evidencias), so deliveries are operated
 * from Despacho, from the trip page or from the driver PWA — never from a
 * generic note box.
 */

const DELIVERY_ROW_KIND = 'delivery_order';
const TRIP_ROW_KIND = 'trip';

const DELIVERY_OPEN = Prisma.sql`d."status" IN (${Prisma.join([...DELIVERY_ORDER_OPEN_STATUSES])})`;
const TRIP_OPEN = Prisma.sql`t."status" IN (${Prisma.join([...TRIP_ACTIVE_STATUSES])})`;

function scopeCondition(scope: AreaWorkSqlFilters['scope'], open: Prisma.Sql): Prisma.Sql {
  if (scope === 'open') return Prisma.sql`AND ${open}`;
  if (scope === 'closed') return Prisma.sql`AND NOT (${open})`;
  return Prisma.empty;
}

/** `CASE WHEN col = 'a' THEN 'A' … ELSE col END` built from a label table of this module. */
function labelCase(column: Prisma.Sql, labels: Readonly<Record<string, string>>): Prisma.Sql {
  const whens = Object.entries(labels).map(
    ([key, label]) => Prisma.sql`WHEN ${column} = ${key} THEN ${label}`
  );
  return Prisma.sql`CASE ${Prisma.join(whens, ' ')} ELSE ${column} END`;
}

/**
 * Calling off a trip that is not going to run (plan §4 `Trip.status = cancelled`).
 * It asks for a reason and releases every delivery of the trip without marking
 * a single stop as failed, so it never opens a false delivery incident.
 */
const TRIP_CANCEL_ACTION = {
  id: 'trip.cancel',
  label: 'Cancelar viaje',
  commandType: LOGISTICS_COMMANDS.tripCancel,
  aggregateType: LOGISTICS_OBJECT_TYPES.trip,
  form: 'reason',
  tone: 'danger',
  successMessage: 'Viaje cancelado',
  hint: 'Las entregas vuelven a despacho sin marcarse como fallidas. Un viaje que ya entregó algo se cierra, no se cancela.',
  permissions: ['logistics.dispatch'],
};

const TRIP_START_ACTIONS = JSON.stringify([
  {
    id: 'trip.start',
    label: 'Iniciar viaje',
    commandType: LOGISTICS_COMMANDS.tripStart,
    aggregateType: LOGISTICS_OBJECT_TYPES.trip,
    form: 'none',
    tone: 'primary',
    successMessage: 'Viaje iniciado',
    hint: 'Las entregas del viaje quedan en camino y se escribe su embarque en Zoho.',
    permissions: ['logistics.dispatch'],
  },
  TRIP_CANCEL_ACTION,
]);

const TRIP_CLOSE_ACTIONS = JSON.stringify([
  {
    id: 'trip.close',
    label: 'Cerrar viaje',
    commandType: LOGISTICS_COMMANDS.tripClose,
    aggregateType: LOGISTICS_OBJECT_TYPES.trip,
    form: 'none',
    tone: 'primary',
    confirm: '¿Cerrar el viaje? Cada parada debe estar entregada o marcada como fallida.',
    successMessage: 'Viaje cerrado',
    permissions: ['logistics.dispatch'],
  },
  TRIP_CANCEL_ACTION,
]);

/**
 * Delivery orders of the area. The owner of the row is the user linked to the
 * assigned driver, so "Míos" works for a driver and the escalation ladder of
 * the core keeps pointing at the work item, not at the delivery.
 */
export function deliveryOrderBranch(): WorkRowBranch {
  return {
    rowKind: DELIVERY_ROW_KIND,
    sql: (filters) => {
      const caseFilter = filters.caseId
        ? Prisma.sql`AND d."caseId" = ${filters.caseId}`
        : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND dr."userId" = ${filters.ownerUserId}`
        : Prisma.empty;
      return areaWorkRowSelect({
        rowKind: DELIVERY_ROW_KIND,
        from: Prisma.sql`FROM "DeliveryOrder" d
          LEFT JOIN "OperationalCase" c ON c."id" = d."caseId"
          LEFT JOIN "Trip" t ON t."id" = d."tripId"
          LEFT JOIN "Vehicle" v ON v."id" = d."vehicleId"
          LEFT JOIN "Driver" dr ON dr."id" = d."driverId"`,
        where: Prisma.sql`WHERE TRUE ${caseFilter} ${ownerFilter} ${scopeCondition(filters.scope, DELIVERY_OPEN)}`,
        columns: {
          sourceId: Prisma.sql`d."id"`,
          areaKey: Prisma.sql`${filters.areaKey}::text`,
          caseId: Prisma.sql`d."caseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`COALESCE(c."customerName", d."contactName")`,
          title: Prisma.sql`concat_ws(' · ',
            COALESCE('Entrega ' || COALESCE(NULLIF(c."salesOrderNumber", ''), c."caseNumber"), 'Entrega'),
            NULLIF(d."city", ''))`,
          status: Prisma.sql`d."status"`,
          priority: Prisma.sql`COALESCE(c."priority", 'normal')`,
          ownerUserId: Prisma.sql`dr."userId"`,
          dueAt: Prisma.sql`COALESCE(d."windowEnd", d."plannedDate")`,
          startedAt: Prisma.sql`CASE WHEN d."status" = 'dispatched' THEN t."startedAt" END`,
          lastActivityAt: Prisma.sql`d."updatedAt"`,
          objectType: Prisma.sql`${LOGISTICS_OBJECT_TYPES.deliveryOrder}::text`,
          objectId: Prisma.sql`d."id"`,
          counterpartyName: Prisma.sql`COALESCE(NULLIF(d."carrier", ''), v."label", d."contactName")`,
          locationCode: Prisma.sql`NULLIF(concat_ws(', ', NULLIF(d."city", ''), NULLIF(d."state", '')), '')`,
          quantity: Prisma.sql`cardinality(d."allocationIds")::numeric`,
          version: Prisma.sql`d."version"`,
          open: DELIVERY_OPEN,
          extra: Prisma.sql`jsonb_build_object(
            'carrier', COALESCE(NULLIF(d."carrier", ''), v."label"),
            'plannedDate', d."plannedDate",
            'statusLabel', ${labelCase(Prisma.sql`d."status"`, DELIVERY_ORDER_STATUS_LABELS)},
            'mode', d."mode",
            'modeLabel', ${labelCase(Prisma.sql`d."mode"`, DELIVERY_MODE_LABELS)},
            'zohoSyncState', d."zohoSyncState",
            'zohoError', d."zohoError",
            'zohoPackageId', d."zohoPackageId",
            'packageId', d."packageId",
            'trackingNumber', d."shipmentInput" ->> 'trackingNumber',
            'tripId', d."tripId",
            'tripNumber', t."number",
            'vehicleLabel', v."label",
            'driverId', d."driverId",
            'driverName', dr."name",
            'lines', cardinality(d."allocationIds"),
            'city', d."city",
            'windowStart', d."windowStart",
            'windowEnd', d."windowEnd",
            'lat', d."lat",
            'lng', d."lng",
            'deliveredAt', d."deliveredAt",
            'receivedBy', d."receivedBy"
          )`,
        },
      });
    },
  };
}

/** Trips of the own fleet, with the progress of their stops. */
export function tripBranch(): WorkRowBranch {
  return {
    rowKind: TRIP_ROW_KIND,
    sql: (filters) => {
      // A trip does not belong to one case: filtering by case leaves it out.
      const caseFilter = filters.caseId ? Prisma.sql`AND FALSE` : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND dr."userId" = ${filters.ownerUserId}`
        : Prisma.empty;
      return areaWorkRowSelect({
        rowKind: TRIP_ROW_KIND,
        from: Prisma.sql`FROM "Trip" t
          JOIN "Vehicle" v ON v."id" = t."vehicleId"
          JOIN "Driver" dr ON dr."id" = t."driverId"
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS "total",
                   count(*) FILTER (WHERE s."status" = 'pending')::int AS "pending",
                   count(*) FILTER (WHERE s."status" = 'done')::int AS "done",
                   count(*) FILTER (WHERE s."status" = 'failed')::int AS "failed",
                   min(s."etaAt") FILTER (WHERE s."status" IN ('pending', 'arrived')) AS "nextEtaAt"
            FROM "TripStop" s WHERE s."tripId" = t."id"
          ) st ON TRUE`,
        where: Prisma.sql`WHERE TRUE ${caseFilter} ${ownerFilter} ${scopeCondition(filters.scope, TRIP_OPEN)}`,
        columns: {
          sourceId: Prisma.sql`t."id"`,
          areaKey: Prisma.sql`${filters.areaKey}::text`,
          title: Prisma.sql`concat_ws(' · ', 'Viaje ' || t."number", NULLIF(v."label", ''))`,
          status: Prisma.sql`t."status"`,
          ownerUserId: Prisma.sql`dr."userId"`,
          dueAt: Prisma.sql`COALESCE(st."nextEtaAt", t."date")`,
          startedAt: Prisma.sql`t."startedAt"`,
          lastActivityAt: Prisma.sql`t."updatedAt"`,
          objectType: Prisma.sql`${LOGISTICS_OBJECT_TYPES.trip}::text`,
          objectId: Prisma.sql`t."id"`,
          counterpartyName: Prisma.sql`dr."name"`,
          locationCode: Prisma.sql`v."code"`,
          quantity: Prisma.sql`COALESCE(st."total", 0)::numeric`,
          version: Prisma.sql`t."version"`,
          open: TRIP_OPEN,
          extra: Prisma.sql`jsonb_build_object(
            'carrier', v."label",
            'plannedDate', t."date",
            'statusLabel', ${labelCase(Prisma.sql`t."status"`, TRIP_STATUS_LABELS)},
            'number', t."number",
            'vehicleId', t."vehicleId",
            'vehicleCode', v."code",
            'vehicleLabel', v."label",
            'plate', v."plate",
            'driverId', t."driverId",
            'driverName', dr."name",
            'driverPhone', dr."phone",
            'driverActive', dr."active",
            'stopsTotal', COALESCE(st."total", 0),
            'stopsPending', COALESCE(st."pending", 0),
            'stopsDone', COALESCE(st."done", 0),
            'stopsFailed', COALESCE(st."failed", 0),
            'nextEtaAt', st."nextEtaAt",
            'notes', t."notes",
            'actions', CASE
              WHEN t."status" = 'planned' THEN ${TRIP_START_ACTIONS}::jsonb
              WHEN t."status" = 'en_route' THEN ${TRIP_CLOSE_ACTIONS}::jsonb
              ELSE '[]'::jsonb END
          )`,
        },
      });
    },
  };
}

/** Branches Logística adds to the common ones (declared in `AREA_REGISTRY.logistica`). */
export function logisticsWorkRowBranches(): WorkRowBranch[] {
  return [deliveryOrderBranch(), tripBranch()];
}
