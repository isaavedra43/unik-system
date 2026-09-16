import { Prisma } from '@prisma/client';
import {
  areaWorkRowSelect,
  workItemBranch,
  type AreaWorkSqlFilters,
  type WorkRowBranch,
} from '@/modules/areas/work-rows-sql';
import type { AreaWorkScope } from '@/modules/areas/work-filters';
import {
  COUNT_OPEN_STATUSES,
  COUNT_SCOPE_LABELS,
  LEGACY_CLAIM_SOURCE_LABELS,
  LEGACY_CLAIM_STATUS_LABELS,
  MOVEMENT_KIND_LABELS,
  RESERVATION_STATUS_LABELS,
} from '@/modules/inventory/inventory-types';
import { WORK_ITEM_OPEN_STATUSES } from '@/modules/operations/types';

/**
 * Work rows of Inventario (plan 7.4): the verification work items, the counts,
 * the active reservations and the movements of the day, on top of the common
 * branches every area gets (its work items and the requests it received and
 * sent).
 *
 * RULES OF THE FRAME, kept here:
 * - every branch is built with `areaWorkRowSelect`, which fills the 24
 *   canonical columns in order (that is what makes the `UNION ALL` valid);
 * - everything a person can influence travels as a bound parameter; the only
 *   literals are column names and the state vocabulary of the module;
 * - the `work_item` branch of the core is REPLACED by the same query minus the
 *   verification items, so a verification appears once (in its own row kind)
 *   and never twice.
 *
 * Actions: domain rows carry them in `extra.actions` and `work-actions.ts`
 * validates and filters them. Verification rows reuse the core work-item
 * commands, so they are marked `participantOnly` — the engine applies exactly
 * the same rule (owner, backup or `operations.manage`).
 */

export const VERIFICATION_WORK_ITEM_KIND = 'verification';

/**
 * An open count without movement for this long is shown as overdue. The engine
 * has no due date for counts: this is the area's own service level, stated here
 * so the table, the panel and the alerts agree.
 */
export const COUNT_SLA_HOURS = 24;

/** Movements stay in the work centre for a week; "abiertos" means today's. */
export const MOVEMENT_WINDOW_DAYS = 7;

const TIMEZONE = 'America/Mexico_City';

/** Instant of the last local midnight (Mexico City), so "hoy" means the warehouse's day. */
export function startOfLocalDay(now: Date, timeZone: string = TIMEZONE): Date {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(now)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const year = Number(parts.year);
  const month = Number(parts.month) - 1;
  const day = Number(parts.day);
  // Some runtimes format midnight as hour 24.
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    const fallback = new Date(now);
    fallback.setHours(0, 0, 0, 0);
    return fallback;
  }
  const wallClockAsUtc = Date.UTC(year, month, day, hour, minute, second);
  const offsetMs = wallClockAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(year, month, day) - offsetMs);
}

// ---------------------------------------------------------------------------
// Actions declared by the branches
// ---------------------------------------------------------------------------

interface BranchAction {
  id: string;
  label: string;
  commandType: string;
  aggregateType: string;
  form?: 'none' | 'note' | 'reason' | 'wait' | 'answer';
  tone?: 'primary' | 'default' | 'danger';
  confirm?: string;
  successMessage: string;
  hint?: string;
  permissions?: string[];
  /** Payload the command needs besides what the dialog asks for. */
  payload?: Record<string, string | number | boolean>;
  /** Only the owner, the backup or an operations manager sees it. */
  participantOnly?: boolean;
}

const START_ACTION: BranchAction = {
  id: 'workitem.start',
  label: 'Iniciar',
  commandType: 'workitem.start',
  aggregateType: 'work_item',
  tone: 'primary',
  successMessage: 'Verificación iniciada',
  participantOnly: true,
};

const COMPLETE_ACTION: BranchAction = {
  id: 'workitem.complete',
  label: 'Completar',
  commandType: 'workitem.complete',
  aggregateType: 'work_item',
  form: 'note',
  successMessage: 'Verificación completada',
  hint: 'Di qué encontraste; si el artículo no está controlado, primero levanta un conteo.',
  participantOnly: true,
};

const WAIT_ACTION: BranchAction = {
  id: 'workitem.wait',
  label: 'Poner en espera',
  commandType: 'workitem.wait',
  aggregateType: 'work_item',
  form: 'wait',
  successMessage: 'Verificación en espera',
  hint: 'Di de qué depende (un conteo, una recepción) y hasta cuándo esperas.',
  participantOnly: true,
};

const ESCALATE_ACTION: BranchAction = {
  id: 'workitem.escalate',
  label: 'Escalar',
  commandType: 'workitem.escalate',
  aggregateType: 'work_item',
  form: 'note',
  successMessage: 'Verificación escalada',
  hint: 'Explica por qué necesitas ayuda; avisamos al siguiente nivel.',
  participantOnly: true,
};

/** Same transition table as the core (`work-actions.ts`), per work-item status. */
const VERIFICATION_ACTIONS: Readonly<Record<string, BranchAction[]>> = {
  open: [{ ...START_ACTION }, { ...COMPLETE_ACTION }, { ...WAIT_ACTION }, { ...ESCALATE_ACTION }],
  in_progress: [
    { ...COMPLETE_ACTION, tone: 'primary' },
    { ...WAIT_ACTION },
    { ...ESCALATE_ACTION },
  ],
  waiting: [{ ...START_ACTION }, { ...COMPLETE_ACTION }, { ...ESCALATE_ACTION }],
  escalated: [
    { ...START_ACTION },
    { ...COMPLETE_ACTION },
    { ...WAIT_ACTION },
    { ...ESCALATE_ACTION },
  ],
};

function countActions(countId: Prisma.Sql): Prisma.Sql {
  // The count id travels inside the row, so the action payload is built per row.
  return Prisma.sql`jsonb_build_array(
    jsonb_build_object(
      'id', 'count.close', 'label', 'Cerrar conteo',
      'commandType', 'stock.count.close', 'aggregateType', 'stock_count',
      'form', 'none', 'tone', 'primary',
      'confirm', 'Al cerrar se aplican las diferencias dentro de tolerancia y se abren las disputas. ¿Cerrar el conteo?',
      'successMessage', 'Conteo cerrado',
      'permissions', jsonb_build_array('inventory.count'),
      'payload', jsonb_build_object('countId', ${countId})
    ),
    jsonb_build_object(
      'id', 'count.cancel', 'label', 'Cancelar conteo',
      'commandType', 'stock.count.cancel', 'aggregateType', 'stock_count',
      'form', 'none', 'tone', 'danger',
      'confirm', '¿Cancelar el conteo? Las líneas capturadas se descartan.',
      'successMessage', 'Conteo cancelado',
      'permissions', jsonb_build_array('inventory.count'),
      'payload', jsonb_build_object('countId', ${countId})
    )
  )`;
}

function reservationActions(reservationId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`jsonb_build_array(
    jsonb_build_object(
      'id', 'reservation.release', 'label', 'Liberar reserva',
      'commandType', 'stock.release', 'aggregateType', 'stock_reservation',
      'form', 'reason', 'tone', 'danger',
      'confirm', 'La cantidad vuelve a estar disponible para otros expedientes. ¿Liberar?',
      'successMessage', 'Reserva liberada',
      'hint', 'Di por qué se libera: queda en la bitácora del expediente.',
      'permissions', jsonb_build_array('inventory.reserve'),
      'payload', jsonb_build_object('reservationId', ${reservationId})
    )
  )`;
}

/**
 * Un reclamo legado se LIBERA con un motivo (el otro camino, confirmarlo contra
 * una necesidad del expediente, necesita elegir expediente y necesidad: eso vive
 * en el panel de gestión de la fila, no en el diálogo genérico).
 */
function legacyClaimActions(claimId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`jsonb_build_array(
    jsonb_build_object(
      'id', 'claim.release', 'label', 'Liberar compromiso',
      'commandType', 'stock.release_legacy', 'aggregateType', 'legacy_claim',
      'form', 'reason', 'tone', 'danger',
      'confirm', 'La cantidad vuelve a estar disponible para otros expedientes. ¿Liberar el compromiso?',
      'successMessage', 'Compromiso liberado',
      'hint', 'Di por qué se libera: queda en la bitácora del artículo.',
      'permissions', jsonb_build_array('inventory.reserve'),
      'payload', jsonb_build_object('claimId', ${claimId})
    )
  )`;
}

function json(value: unknown): Prisma.Sql {
  return Prisma.sql`${JSON.stringify(value)}::jsonb`;
}

/** `CASE <column> WHEN 'a' THEN 'A' … END` built from a label map (values are parameters). */
function labelCase(column: Prisma.Sql, labels: Readonly<Record<string, string>>): Prisma.Sql {
  const whens = Object.entries(labels).map(
    ([key, label]) => Prisma.sql`WHEN ${key}::text THEN ${label}::text`
  );
  return Prisma.sql`CASE ${column} ${Prisma.join(whens, ' ')} ELSE ${column} END`;
}

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

const WORK_ITEM_OPEN = Prisma.sql`w."status" IN (${Prisma.join([...WORK_ITEM_OPEN_STATUSES])})`;
/** Conteo que todavía se está capturando: es el único que se cierra o se cancela. */
const COUNT_CAPTURING = Prisma.sql`sc."status" IN (${Prisma.join([...COUNT_OPEN_STATUSES])})`;
/**
 * Un conteo CERRADO con líneas sin decidir sigue siendo trabajo: mientras quede
 * una diferencia pendiente o en disputa, alguien tiene que autorizarla o
 * resolverla (y el artículo en disputa no se puede prometer). Sin esto esas
 * líneas quedaban fuera del alcance «abiertos», que es el que trae la pestaña
 * de Conteos, y la decisión no aparecía por ningún lado.
 */
const COUNT_UNDECIDED = Prisma.sql`COALESCE(agg.pending_lines, 0) + COALESCE(agg.disputed_lines, 0) > 0`;
const COUNT_OPEN = Prisma.sql`(${COUNT_CAPTURING} OR ${COUNT_UNDECIDED})`;
const RESERVATION_OPEN = Prisma.sql`r."status" = 'active'`;
/** Un compromiso previo al corte sigue restando del disponible mientras está reclamado. */
const CLAIM_OPEN = Prisma.sql`lc."status" = 'claimed'`;

function scopeFilter(scope: AreaWorkScope, open: Prisma.Sql): Prisma.Sql {
  if (scope === 'open') return Prisma.sql`AND ${open}`;
  if (scope === 'closed') return Prisma.sql`AND NOT (${open})`;
  return Prisma.empty;
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

/**
 * Work items of Inventario WITHOUT the verifications (they have their own row
 * kind). Wraps the core branch so it never drifts from it.
 */
export function inventoryWorkItemBranch(): WorkRowBranch {
  const base = workItemBranch();
  return {
    rowKind: 'work_item',
    sql: (filters) =>
      Prisma.sql`SELECT rows.* FROM (${base.sql(filters)}) AS rows WHERE rows."extra" ->> 'kind' <> ${VERIFICATION_WORK_ITEM_KIND}`,
  };
}

/** Verification work items of the area: the queue that decides what can be promised. */
export function verificationBranch(): WorkRowBranch {
  return {
    rowKind: 'verification',
    sql: (filters: AreaWorkSqlFilters) => {
      const caseFilter = filters.caseId
        ? Prisma.sql`AND w."caseId" = ${filters.caseId}`
        : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND (w."ownerUserId" = ${filters.ownerUserId} OR w."backupUserId" = ${filters.ownerUserId})`
        : Prisma.empty;
      return areaWorkRowSelect({
        rowKind: 'verification',
        from: Prisma.sql`FROM "WorkItem" w
          LEFT JOIN "OperationalCase" c ON c."id" = w."caseId"
          LEFT JOIN "CaseStep" s ON s."id" = w."stepId"
          LEFT JOIN "CaseDemand" d ON d."id" = s."demandId"
          LEFT JOIN "ProductInventoryProfile" pr ON pr."zohoItemId" = d."zohoItemId"
          LEFT JOIN "Product" pd ON pd."zohoItemId" = d."zohoItemId"`,
        where: Prisma.sql`WHERE w."areaKey" = ${filters.areaKey} AND w."kind" = ${VERIFICATION_WORK_ITEM_KIND} ${caseFilter} ${ownerFilter} ${scopeFilter(filters.scope, WORK_ITEM_OPEN)}`,
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
          quantity: Prisma.sql`d."baseQuantity"`,
          version: Prisma.sql`w."version"`,
          open: WORK_ITEM_OPEN,
          extra: Prisma.sql`jsonb_build_object(
            'kind', w."kind",
            'description', w."description",
            'backupUserId', w."backupUserId",
            'waitUntil', w."waitUntil",
            'stepId', w."stepId",
            'stepKey', s."stepKey",
            'requiredEvidence', to_jsonb(w."requiredEvidence"),
            'salesOrderNumber', c."salesOrderNumber",
            'phase', c."phase",
            'demandId', d."id",
            'zohoItemId', d."zohoItemId",
            'productName', COALESCE(pd."name", d."name"),
            'sku', COALESCE(d."sku", pd."sku"),
            'unit', d."baseUnit",
            'confidence', COALESCE(pr."confidence", 'UNCOUNTED'),
            'actions', CASE w."status"
              WHEN 'open' THEN ${json(VERIFICATION_ACTIONS.open)}
              WHEN 'in_progress' THEN ${json(VERIFICATION_ACTIONS.in_progress)}
              WHEN 'waiting' THEN ${json(VERIFICATION_ACTIONS.waiting)}
              WHEN 'escalated' THEN ${json(VERIFICATION_ACTIONS.escalated)}
              ELSE '[]'::jsonb END
          )`,
        },
      });
    },
  };
}

/** Physical counts of the warehouses, open and closed. */
export function stockCountBranch(): WorkRowBranch {
  return {
    rowKind: 'stock_count',
    sql: (filters: AreaWorkSqlFilters) => {
      // Counts do not belong to a case: a case filter leaves the branch empty.
      const caseFilter = filters.caseId ? Prisma.sql`AND FALSE` : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND sc."startedBy" = ${filters.ownerUserId}`
        : Prisma.empty;
      const scopeLabel = labelCase(Prisma.sql`sc."scope"`, COUNT_SCOPE_LABELS);
      return areaWorkRowSelect({
        rowKind: 'stock_count',
        from: Prisma.sql`FROM "StockCount" sc
          JOIN "Warehouse" wh ON wh."id" = sc."warehouseId"
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS lines_total,
                   count(*) FILTER (WHERE NOT l."withinTolerance")::int AS out_of_tolerance,
                   count(*) FILTER (WHERE l."resolution" = 'pending')::int AS pending_lines,
                   count(*) FILTER (WHERE l."resolution" = 'disputed')::int AS disputed_lines,
                   max(l."countedAt") AS last_line_at
            FROM "StockCountLine" l WHERE l."countId" = sc."id"
          ) agg ON TRUE`,
        where: Prisma.sql`WHERE TRUE ${caseFilter} ${ownerFilter} ${scopeFilter(filters.scope, COUNT_OPEN)}`,
        columns: {
          sourceId: Prisma.sql`sc."id"`,
          areaKey: Prisma.sql`${filters.areaKey}::text`,
          title: Prisma.sql`('Conteo ' || lower(${scopeLabel}) || ' · ' || wh."name")`,
          status: Prisma.sql`sc."status"`,
          ownerUserId: Prisma.sql`sc."startedBy"`,
          // El nivel de servicio corre mientras se captura; una diferencia sin
          // decidir no tiene fecha límite propia en el plan.
          dueAt: Prisma.sql`CASE WHEN ${COUNT_CAPTURING} THEN sc."createdAt" + ${`${COUNT_SLA_HOURS} hours`}::interval END`,
          startedAt: Prisma.sql`sc."createdAt"`,
          lastActivityAt: Prisma.sql`GREATEST(sc."updatedAt", COALESCE(agg.last_line_at, sc."updatedAt"))`,
          objectType: Prisma.sql`'stock_count'::text`,
          objectId: Prisma.sql`sc."id"`,
          counterpartyName: Prisma.sql`wh."name"`,
          locationCode: Prisma.sql`wh."key"`,
          quantity: Prisma.sql`agg.lines_total::numeric`,
          version: Prisma.sql`sc."version"`,
          open: COUNT_OPEN,
          extra: Prisma.sql`jsonb_build_object(
            'scope', sc."scope",
            'scopeLabel', ${scopeLabel},
            'warehouseId', sc."warehouseId",
            'warehouseName', wh."name",
            'lines', COALESCE(agg.lines_total, 0),
            'outOfTolerance', COALESCE(agg.out_of_tolerance, 0),
            'pendingLines', COALESCE(agg.pending_lines, 0),
            'disputedLines', COALESCE(agg.disputed_lines, 0),
            'closedAt', sc."closedAt",
            'decisionsPending', COALESCE(agg.pending_lines, 0) + COALESCE(agg.disputed_lines, 0),
            /* Cerrar y cancelar sólo existen mientras se captura; las diferencias
               de un conteo cerrado se deciden en su panel. */
            'actions', CASE WHEN ${COUNT_CAPTURING} THEN ${countActions(Prisma.sql`sc."id"`)} ELSE '[]'::jsonb END
          )`,
        },
      });
    },
  };
}

/** Active reservations: the stock already committed to a case. */
export function reservationBranch(): WorkRowBranch {
  return {
    rowKind: 'reservation',
    sql: (filters: AreaWorkSqlFilters) => {
      const caseFilter = filters.caseId
        ? Prisma.sql`AND r."caseId" = ${filters.caseId}`
        : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND c."ownerUserId" = ${filters.ownerUserId}`
        : Prisma.empty;
      const statusLabel = labelCase(Prisma.sql`r."status"`, RESERVATION_STATUS_LABELS);
      return areaWorkRowSelect({
        rowKind: 'reservation',
        from: Prisma.sql`FROM "StockReservation" r
          JOIN "StockItem" si ON si."id" = r."stockItemId"
          LEFT JOIN "OperationalCase" c ON c."id" = r."caseId"
          LEFT JOIN "Product" pd ON pd."zohoItemId" = r."zohoItemId"
          LEFT JOIN "ProductInventoryProfile" pr ON pr."zohoItemId" = r."zohoItemId"
          LEFT JOIN "Warehouse" wh ON wh."id" = r."warehouseId"
          LEFT JOIN "StorageLocation" loc ON loc."id" = si."locationId"`,
        where: Prisma.sql`WHERE TRUE ${caseFilter} ${ownerFilter} ${scopeFilter(filters.scope, RESERVATION_OPEN)}`,
        columns: {
          sourceId: Prisma.sql`r."id"`,
          areaKey: Prisma.sql`${filters.areaKey}::text`,
          caseId: Prisma.sql`r."caseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`('Reserva · ' || COALESCE(pd."name", pd."sku", r."zohoItemId"))`,
          status: Prisma.sql`r."status"`,
          priority: Prisma.sql`COALESCE(c."priority", 'normal')`,
          ownerUserId: Prisma.sql`c."ownerUserId"`,
          dueAt: Prisma.sql`r."expiresAt"`,
          startedAt: Prisma.sql`r."createdAt"`,
          lastActivityAt: Prisma.sql`r."updatedAt"`,
          objectType: Prisma.sql`'stock_reservation'::text`,
          objectId: Prisma.sql`r."id"`,
          counterpartyName: Prisma.sql`wh."name"`,
          locationCode: Prisma.sql`loc."code"`,
          quantity: Prisma.sql`r."quantity"`,
          version: Prisma.sql`r."version"`,
          open: RESERVATION_OPEN,
          extra: Prisma.sql`jsonb_build_object(
            'statusLabel', ${statusLabel},
            'zohoItemId', r."zohoItemId",
            'sku', pd."sku",
            'productName', pd."name",
            'warehouseId', r."warehouseId",
            'warehouseName', wh."name",
            'stockItemId', r."stockItemId",
            'variantKey', si."variantKey",
            'containerKey', si."containerKey",
            'demandId', r."demandId",
            'allocationId', r."allocationId",
            'confidence', COALESCE(pr."confidence", 'UNCOUNTED'),
            'confidenceAtReserve', r."confidenceAtReserve",
            'reservedAt', r."createdAt",
            'unit', COALESCE(pr."baseUnit", pd."unit"),
            'actions', CASE WHEN ${RESERVATION_OPEN} THEN ${reservationActions(Prisma.sql`r."id"`)} ELSE '[]'::jsonb END
          )`,
        },
      });
    },
  };
}

/**
 * Movements of the day (and of the last week under "Todos"): the pulse of the
 * warehouse. They are a ledger, so they carry no actions.
 */
export function movementBranch(): WorkRowBranch {
  return {
    rowKind: 'movement',
    sql: (filters: AreaWorkSqlFilters) => {
      // Movements do not belong to a case; a case filter leaves the branch empty.
      const caseFilter = filters.caseId ? Prisma.sql`AND FALSE` : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND m."actorId" = ${filters.ownerUserId}`
        : Prisma.empty;
      const today = startOfLocalDay(filters.now);
      const windowStart = new Date(today.getTime() - (MOVEMENT_WINDOW_DAYS - 1) * 86_400_000);
      const isToday = Prisma.sql`m."occurredAt" >= ${today}`;
      const kindLabel = labelCase(Prisma.sql`m."kind"`, MOVEMENT_KIND_LABELS);
      return areaWorkRowSelect({
        rowKind: 'movement',
        from: Prisma.sql`FROM "StockMovement" m
          JOIN "StockItem" si ON si."id" = m."stockItemId"
          LEFT JOIN "Product" pd ON pd."zohoItemId" = m."zohoItemId"
          LEFT JOIN "ProductInventoryProfile" pr ON pr."zohoItemId" = m."zohoItemId"
          LEFT JOIN "Warehouse" wh ON wh."id" = m."warehouseId"
          LEFT JOIN "StorageLocation" loc ON loc."id" = si."locationId"`,
        where: Prisma.sql`WHERE m."occurredAt" >= ${windowStart} ${caseFilter} ${ownerFilter} ${scopeFilter(filters.scope, isToday)}`,
        columns: {
          sourceId: Prisma.sql`m."id"`,
          areaKey: Prisma.sql`${filters.areaKey}::text`,
          title: Prisma.sql`(${kindLabel} || ' · ' || COALESCE(pd."name", pd."sku", m."zohoItemId"))`,
          status: Prisma.sql`m."kind"`,
          ownerUserId: Prisma.sql`m."actorId"`,
          startedAt: Prisma.sql`m."occurredAt"`,
          lastActivityAt: Prisma.sql`m."occurredAt"`,
          objectType: Prisma.sql`'stock_movement'::text`,
          objectId: Prisma.sql`m."id"`,
          counterpartyName: Prisma.sql`wh."name"`,
          locationCode: Prisma.sql`loc."code"`,
          quantity: Prisma.sql`m."quantity"`,
          open: isToday,
          extra: Prisma.sql`jsonb_build_object(
            'statusLabel', ${kindLabel},
            'statusTone', CASE WHEN m."kind" IN ('receipt', 'return', 'produce', 'transfer_in') THEN 'success'
                               WHEN m."kind" IN ('issue', 'consume', 'transfer_out') THEN 'info'
                               WHEN m."kind" IN ('adjust', 'block') THEN 'warning'
                               ELSE 'default' END,
            'kind', m."kind",
            'kindLabel', ${kindLabel},
            'zohoItemId', m."zohoItemId",
            'sku', pd."sku",
            'productName', pd."name",
            'warehouseId', m."warehouseId",
            'warehouseName', wh."name",
            'stockItemId', m."stockItemId",
            'variantKey', si."variantKey",
            'containerKey', si."containerKey",
            'originalQuantity', m."originalQuantity",
            'originalUnit', m."originalUnit",
            'unit', COALESCE(pr."baseUnit", m."originalUnit"),
            'referenceType', m."referenceType",
            'referenceId', m."referenceId",
            'note', m."note",
            'occurredAt', m."occurredAt",
            'confidence', COALESCE(pr."confidence", 'UNCOUNTED'),
            'actions', '[]'::jsonb
          )`,
        },
      });
    },
  };
}

/**
 * Compromisos previos al corte (plan §3.3): lo prometido antes de que UNIK
 * controlara la bodega. Mientras están `claimed` restan del disponible, así que
 * son trabajo de verdad: hay que confirmarlos contra un expediente o liberarlos
 * antes de que venzan.
 */
export function legacyClaimBranch(): WorkRowBranch {
  return {
    rowKind: 'legacy_claim',
    sql: (filters: AreaWorkSqlFilters) => {
      const caseFilter = filters.caseId
        ? Prisma.sql`AND lc."caseId" = ${filters.caseId}`
        : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND lc."claimedBy" = ${filters.ownerUserId}`
        : Prisma.empty;
      const statusLabel = labelCase(Prisma.sql`lc."status"`, LEGACY_CLAIM_STATUS_LABELS);
      const sourceLabel = labelCase(Prisma.sql`lc."source"`, LEGACY_CLAIM_SOURCE_LABELS);
      return areaWorkRowSelect({
        rowKind: 'legacy_claim',
        from: Prisma.sql`FROM "LegacyCommitmentClaim" lc
          LEFT JOIN "Warehouse" wh ON wh."id" = lc."warehouseId"
          LEFT JOIN "Product" pd ON pd."zohoItemId" = lc."zohoItemId"
          LEFT JOIN "ProductInventoryProfile" pr ON pr."zohoItemId" = lc."zohoItemId"
          LEFT JOIN "OperationalCase" c ON c."id" = lc."caseId"`,
        where: Prisma.sql`WHERE TRUE ${caseFilter} ${ownerFilter} ${scopeFilter(filters.scope, CLAIM_OPEN)}`,
        columns: {
          sourceId: Prisma.sql`lc."id"`,
          areaKey: Prisma.sql`${filters.areaKey}::text`,
          caseId: Prisma.sql`lc."caseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`('Compromiso previo · ' || COALESCE(pd."name", pd."sku", lc."zohoItemId"))`,
          status: Prisma.sql`lc."status"`,
          ownerUserId: Prisma.sql`lc."claimedBy"`,
          dueAt: Prisma.sql`CASE WHEN ${CLAIM_OPEN} THEN lc."expiresAt" END`,
          startedAt: Prisma.sql`lc."createdAt"`,
          lastActivityAt: Prisma.sql`lc."updatedAt"`,
          objectType: Prisma.sql`'legacy_claim'::text`,
          objectId: Prisma.sql`lc."id"`,
          counterpartyName: Prisma.sql`wh."name"`,
          quantity: Prisma.sql`lc."quantity"`,
          version: Prisma.sql`lc."version"`,
          open: CLAIM_OPEN,
          extra: Prisma.sql`jsonb_build_object(
            'statusLabel', ${statusLabel},
            'statusTone', CASE WHEN lc."status" = 'claimed' THEN 'warning'
                               WHEN lc."status" = 'confirmed' THEN 'success'
                               ELSE 'weak' END,
            'source', lc."source",
            'sourceLabel', ${sourceLabel},
            'reference', lc."reference",
            'zohoItemId', lc."zohoItemId",
            'sku', pd."sku",
            'productName', pd."name",
            'warehouseId', lc."warehouseId",
            'warehouseName', wh."name",
            'variantKey', lc."variantKey",
            'unit', COALESCE(NULLIF(lc."unit", ''), pr."baseUnit"),
            'confidence', COALESCE(pr."confidence", 'UNCOUNTED'),
            'expiresAt', lc."expiresAt",
            'resolvedAt', lc."resolvedAt",
            'actions', CASE WHEN ${CLAIM_OPEN} THEN ${legacyClaimActions(Prisma.sql`lc."id"`)} ELSE '[]'::jsonb END
          )`,
        },
      });
    },
  };
}

/** Every branch Inventario adds to the union (the common ones come from the core). */
export function inventoryWorkRowBranches(): WorkRowBranch[] {
  return [
    inventoryWorkItemBranch(),
    verificationBranch(),
    stockCountBranch(),
    reservationBranch(),
    movementBranch(),
    legacyClaimBranch(),
  ];
}
