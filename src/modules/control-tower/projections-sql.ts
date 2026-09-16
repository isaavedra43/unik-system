import { Prisma } from '@prisma/client';

/**
 * SQL de las proyecciones de inteligencia de procesos (plan 7.9 y 13: `$queryRaw`
 * parametrizado, sin vistas ni preview features).
 *
 * REGLAS DE SEGURIDAD (las verifica la prueba):
 * - todo valor viaja como parámetro (`${valor}`): fechas, ids, topes;
 * - `Prisma.raw` NO se usa en este archivo: no hay un solo identificador
 *   construido con texto de nadie;
 * - las listas de ids se unen con `Prisma.join`, que también las parametriza.
 *
 * Sobre el día: `CaseStep.completedAt` y `OperationalEvent.occurredAt` son
 * `timestamp` sin zona (convención de Prisma en este esquema), así que
 * `(columna)::date` es el día en UTC. `CtStepMetricDaily.day` guarda ese mismo
 * día, de modo que la proyección y la lectura hablan del mismo calendario.
 */

export interface DayWindow {
  /** Inicio inclusive. */
  from: Date;
  /** Fin exclusivo. */
  to: Date;
}

// ---------------------------------------------------------------------------
// Marca de agua y expedientes afectados
// ---------------------------------------------------------------------------

export interface MaxEventIdRow {
  maxId: bigint | null;
}

/** Último id de la bitácora (0 cuando aún no hay eventos). */
export function maxEventIdSql(): Prisma.Sql {
  return Prisma.sql`SELECT MAX("id") AS "maxId" FROM "OperationalEvent"`;
}

export interface AffectedCaseRow {
  caseId: string;
}

/**
 * Expedientes tocados desde la marca de agua. Se releen por `recordedAt` una
 * ventana hacia atrás porque el id se asigna al INSERTAR, no al confirmar: una
 * transacción lenta puede confirmar un id menor que `lastEventId`.
 */
export function affectedCaseIdsSql(input: {
  lastEventId: bigint;
  since: Date;
  limit: number;
}): Prisma.Sql {
  return Prisma.sql`
    SELECT DISTINCT e."caseId" AS "caseId"
    FROM "OperationalEvent" e
    WHERE e."caseId" IS NOT NULL
      AND (e."id" > ${input.lastEventId} OR e."recordedAt" >= ${input.since})
    LIMIT ${input.limit}
  `;
}

export interface CaseSequenceRow {
  caseId: string;
  sequence: string[];
  scopes: string[];
  firstAt: Date | null;
  lastAt: Date | null;
}

/** Secuencia de pasos completados por expediente, en orden real (`occurredAt, id`). */
export function caseSequenceSql(caseIds: readonly string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT e."caseId" AS "caseId",
      COALESCE(
        array_agg(e."payload" ->> 'stepKey' ORDER BY e."occurredAt", e."id")
          FILTER (WHERE e."payload" ->> 'stepKey' IS NOT NULL),
        ARRAY[]::text[]
      ) AS "sequence",
      COALESCE(
        array_agg(COALESCE(e."payload" ->> 'scopeKey', '') ORDER BY e."occurredAt", e."id")
          FILTER (WHERE e."payload" ->> 'stepKey' IS NOT NULL),
        ARRAY[]::text[]
      ) AS "scopes",
      MIN(e."occurredAt") AS "firstAt",
      MAX(e."occurredAt") AS "lastAt"
    FROM "OperationalEvent" e
    WHERE e."type" = 'step.completed'
      AND e."caseId" IN (${Prisma.join(caseIds)})
    GROUP BY e."caseId"
  `;
}

export interface CaseActivationRow {
  caseId: string;
  stepKey: string;
  scopeKey: string;
  activations: number;
}

/** Activaciones por paso (arranques y reaperturas): la base del retrabajo. */
export function caseActivationsSql(caseIds: readonly string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT e."caseId" AS "caseId",
      e."payload" ->> 'stepKey' AS "stepKey",
      COALESCE(e."payload" ->> 'scopeKey', '') AS "scopeKey",
      COUNT(*)::int AS "activations"
    FROM "OperationalEvent" e
    WHERE e."type" IN ('step.started', 'step.reopened')
      AND e."payload" ->> 'stepKey' IS NOT NULL
      AND e."caseId" IN (${Prisma.join(caseIds)})
    GROUP BY 1, 2, 3
  `;
}

// ---------------------------------------------------------------------------
// Métricas por paso
// ---------------------------------------------------------------------------

export interface StepCompletionRow {
  day: Date;
  processKey: string;
  stepKey: string;
  areaKey: string;
  completed: number;
  p50ActiveMin: number | null;
  p90ActiveMin: number | null;
  avgActiveMin: number | null;
  breached: number;
}

/** Pasos cerrados por día: percentiles de minutos activos e incumplimientos de SLA. */
export function stepCompletionMetricsSql(window: DayWindow): Prisma.Sql {
  const activeMinutes = Prisma.sql`EXTRACT(EPOCH FROM (s."completedAt" - COALESCE(s."startedAt", s."createdAt"))) / 60.0`;
  return Prisma.sql`
    SELECT (s."completedAt")::date AS "day",
      pv."processKey" AS "processKey",
      s."stepKey" AS "stepKey",
      MIN(s."areaKey") AS "areaKey",
      COUNT(*)::int AS "completed",
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY ${activeMinutes}))::float8 AS "p50ActiveMin",
      (percentile_cont(0.9) WITHIN GROUP (ORDER BY ${activeMinutes}))::float8 AS "p90ActiveMin",
      (AVG(${activeMinutes}))::float8 AS "avgActiveMin",
      COUNT(*) FILTER (WHERE s."dueAt" IS NOT NULL AND s."completedAt" > s."dueAt")::int AS "breached"
    FROM "CaseStep" s
    JOIN "ProcessVersion" pv ON pv."id" = s."processVersionId"
    WHERE s."completedAt" >= ${window.from}
      AND s."completedAt" < ${window.to}
      AND s."status" = 'done'
    GROUP BY 1, 2, 3
  `;
}

export interface StepStartedRow {
  day: Date;
  processKey: string;
  stepKey: string;
  areaKey: string;
  started: number;
}

/** Pasos iniciados por día (denominador de los cuellos de botella). */
export function stepStartedSql(window: DayWindow): Prisma.Sql {
  return Prisma.sql`
    SELECT (s."startedAt")::date AS "day",
      pv."processKey" AS "processKey",
      s."stepKey" AS "stepKey",
      MIN(s."areaKey") AS "areaKey",
      COUNT(*)::int AS "started"
    FROM "CaseStep" s
    JOIN "ProcessVersion" pv ON pv."id" = s."processVersionId"
    WHERE s."startedAt" >= ${window.from}
      AND s."startedAt" < ${window.to}
    GROUP BY 1, 2, 3
  `;
}

export interface StepReworkRow {
  day: Date;
  processKey: string;
  stepKey: string;
  reworked: number;
}

/** Reaperturas por día: un paso que se volvió a abrir es retrabajo. */
export function stepReworkSql(window: DayWindow): Prisma.Sql {
  return Prisma.sql`
    SELECT (e."occurredAt")::date AS "day",
      pv."processKey" AS "processKey",
      e."payload" ->> 'stepKey' AS "stepKey",
      COUNT(*)::int AS "reworked"
    FROM "OperationalEvent" e
    JOIN "OperationalCase" c ON c."id" = e."caseId"
    JOIN "ProcessVersion" pv ON pv."id" = c."processVersionId"
    WHERE e."type" = 'step.reopened'
      AND e."occurredAt" >= ${window.from}
      AND e."occurredAt" < ${window.to}
      AND e."payload" ->> 'stepKey' IS NOT NULL
    GROUP BY 1, 2, 3
  `;
}

export interface StepWaitRow {
  day: Date;
  processKey: string;
  stepKey: string;
  p50WaitMin: number | null;
  p90WaitMin: number | null;
  waits: number;
}

/**
 * Esperas por paso: intervalos `step.waiting → siguiente movimiento del mismo
 * paso` con `LEAD()`. La ventana de lectura empieza antes (`windowFrom`) para
 * que una espera iniciada la semana pasada y resuelta hoy cuente hoy.
 */
export function stepWaitSql(input: DayWindow & { windowFrom: Date }): Prisma.Sql {
  return Prisma.sql`
    WITH marks AS (
      SELECT e."caseId" AS "caseId",
        e."objectId" AS "stepId",
        e."type" AS "type",
        e."occurredAt" AS "occurredAt",
        e."payload" ->> 'stepKey' AS "stepKey",
        LEAD(e."occurredAt") OVER (PARTITION BY e."objectId" ORDER BY e."occurredAt", e."id") AS "nextAt"
      FROM "OperationalEvent" e
      WHERE e."objectType" = 'case_step'
        AND e."type" IN ('step.waiting', 'step.started', 'step.completed', 'step.cancelled', 'step.skipped')
        AND e."occurredAt" >= ${input.windowFrom}
        AND e."occurredAt" < ${input.to}
    )
    SELECT (m."nextAt")::date AS "day",
      pv."processKey" AS "processKey",
      m."stepKey" AS "stepKey",
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (m."nextAt" - m."occurredAt")) / 60.0))::float8 AS "p50WaitMin",
      (percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (m."nextAt" - m."occurredAt")) / 60.0))::float8 AS "p90WaitMin",
      COUNT(*)::int AS "waits"
    FROM marks m
    JOIN "OperationalCase" c ON c."id" = m."caseId"
    JOIN "ProcessVersion" pv ON pv."id" = c."processVersionId"
    WHERE m."type" = 'step.waiting'
      AND m."stepKey" IS NOT NULL
      AND m."nextAt" IS NOT NULL
      AND m."nextAt" >= ${input.from}
      AND m."nextAt" < ${input.to}
    GROUP BY 1, 2, 3
  `;
}

// ---------------------------------------------------------------------------
// Traspasos
// ---------------------------------------------------------------------------

export interface HandoffRow {
  day: Date;
  fromAreaKey: string;
  toAreaKey: string;
  count: number;
  p50ResponseMin: number | null;
  p90ResponseMin: number | null;
  expired: number;
}

/**
 * Traspaso por solicitud: de que un área la manda a que el área destino la
 * acusa o la responde. `expired` son las que vencieron sin respuesta.
 */
export function handoffRequestsSql(window: DayWindow): Prisma.Sql {
  return Prisma.sql`
    SELECT (r."createdAt")::date AS "day",
      r."fromAreaKey" AS "fromAreaKey",
      r."toAreaKey" AS "toAreaKey",
      COUNT(*)::int AS "count",
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY resp."minutes"))::float8 AS "p50ResponseMin",
      (percentile_cont(0.9) WITHIN GROUP (ORDER BY resp."minutes"))::float8 AS "p90ResponseMin",
      COUNT(*) FILTER (WHERE r."status" = 'expired')::int AS "expired"
    FROM "AreaRequest" r
    LEFT JOIN LATERAL (
      SELECT (EXTRACT(EPOCH FROM (e."occurredAt" - r."createdAt")) / 60.0)::float8 AS "minutes"
      FROM "OperationalEvent" e
      WHERE e."objectType" = 'area_request'
        AND e."objectId" = r."id"
        AND e."type" IN ('request.acknowledged', 'request.accepted', 'request.resolved', 'request.rejected', 'request.blocked')
      ORDER BY e."occurredAt" ASC, e."id" ASC
      LIMIT 1
    ) resp ON TRUE
    WHERE r."createdAt" >= ${window.from}
      AND r."createdAt" < ${window.to}
    GROUP BY 1, 2, 3
  `;
}

/**
 * Traspaso por reasignación de trabajo: el trabajo cambia de manos dentro del
 * área (escalera de escalamiento o ausencia). `expired` aquí son las
 * reasignaciones que todavía no produjeron ni un arranque ni un cierre.
 */
export function handoffWorkItemsSql(window: DayWindow): Prisma.Sql {
  return Prisma.sql`
    SELECT (e."occurredAt")::date AS "day",
      w."areaKey" AS "fromAreaKey",
      w."areaKey" AS "toAreaKey",
      COUNT(*)::int AS "count",
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY resp."minutes"))::float8 AS "p50ResponseMin",
      (percentile_cont(0.9) WITHIN GROUP (ORDER BY resp."minutes"))::float8 AS "p90ResponseMin",
      COUNT(*) FILTER (WHERE resp."minutes" IS NULL)::int AS "expired"
    FROM "OperationalEvent" e
    JOIN "WorkItem" w ON w."id" = e."objectId"
    LEFT JOIN LATERAL (
      SELECT (EXTRACT(EPOCH FROM (n."occurredAt" - e."occurredAt")) / 60.0)::float8 AS "minutes"
      FROM "OperationalEvent" n
      WHERE n."objectType" = 'work_item'
        AND n."objectId" = w."id"
        AND n."type" IN ('workitem.started', 'workitem.completed')
        AND (n."occurredAt" > e."occurredAt" OR (n."occurredAt" = e."occurredAt" AND n."id" > e."id"))
      ORDER BY n."occurredAt" ASC, n."id" ASC
      LIMIT 1
    ) resp ON TRUE
    WHERE e."type" = 'workitem.reassigned'
      AND e."objectType" = 'work_item'
      AND e."occurredAt" >= ${window.from}
      AND e."occurredAt" < ${window.to}
    GROUP BY 1, 2, 3
  `;
}

// ---------------------------------------------------------------------------
// Causas de bloqueo
// ---------------------------------------------------------------------------

export interface BlockCauseRow {
  day: Date;
  causeType: string;
  causeKey: string;
  causeLabel: string;
  blocks: number;
  waitMin: number;
}

/** Motivo de espera escrito por una persona (texto libre, normalizado y recortado). */
export function blockCauseWaitReasonSql(
  input: DayWindow & { windowFrom: Date; now: Date }
): Prisma.Sql {
  return Prisma.sql`
    WITH waits AS (
      SELECT e."objectId" AS "workItemId",
        e."type" AS "type",
        e."occurredAt" AS "occurredAt",
        e."payload" ->> 'reason' AS "reason",
        LEAD(e."occurredAt") OVER (PARTITION BY e."objectId" ORDER BY e."occurredAt", e."id") AS "nextAt"
      FROM "OperationalEvent" e
      WHERE e."objectType" = 'work_item'
        AND e."type" IN ('workitem.waiting', 'workitem.started', 'workitem.completed', 'workitem.cancelled')
        AND e."occurredAt" >= ${input.windowFrom}
        AND e."occurredAt" < ${input.to}
    )
    SELECT (w."occurredAt")::date AS "day",
      'wait_reason' AS "causeType",
      LOWER(LEFT(COALESCE(NULLIF(BTRIM(w."reason"), ''), 'sin motivo'), 120)) AS "causeKey",
      LEFT(COALESCE(NULLIF(BTRIM(w."reason"), ''), 'Sin motivo'), 120) AS "causeLabel",
      COUNT(*)::int AS "blocks",
      COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(w."nextAt", ${input.now}) - w."occurredAt")) / 60.0), 0)::float8 AS "waitMin"
    FROM waits w
    WHERE w."type" = 'workitem.waiting'
      AND w."occurredAt" >= ${input.from}
      AND w."occurredAt" < ${input.to}
    GROUP BY 1, 2, 3, 4
  `;
}

/** Proveedor detrás de una incidencia: expediente → orden de compra → proveedor. */
export function blockCauseVendorSql(input: DayWindow & { now: Date }): Prisma.Sql {
  return Prisma.sql`
    SELECT (i."openedAt")::date AS "day",
      'vendor' AS "causeType",
      s."id" AS "causeKey",
      s."name" AS "causeLabel",
      COUNT(DISTINCT i."id")::int AS "blocks",
      COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(i."resolvedAt", ${input.now}) - i."openedAt")) / 60.0), 0)::float8 AS "waitMin"
    FROM "Incident" i
    JOIN "ObjectRelation" r1
      ON r1."fromType" = 'operational_case'
     AND r1."fromId" = i."caseId"
     AND r1."toType" = 'procurement_order'
     AND r1."validTo" IS NULL
    JOIN "ObjectRelation" r2
      ON r2."fromType" = 'procurement_order'
     AND r2."fromId" = r1."toId"
     AND r2."toType" = 'supplier'
     AND r2."validTo" IS NULL
    JOIN "Supplier" s ON s."id" = r2."toId"
    WHERE i."openedAt" >= ${input.from}
      AND i."openedAt" < ${input.to}
      AND i."caseId" IS NOT NULL
    GROUP BY 1, 2, 3, 4
  `;
}

/** Producto detrás de una solicitud que bloquea la entrega (SKU del payload). */
export function blockCauseProductSql(input: DayWindow & { now: Date }): Prisma.Sql {
  return Prisma.sql`
    SELECT (r."createdAt")::date AS "day",
      'product' AS "causeType",
      LOWER(LEFT(r."payload" ->> 'sku', 120)) AS "causeKey",
      LEFT(COALESCE(r."payload" ->> 'productName', r."payload" ->> 'sku'), 120) AS "causeLabel",
      COUNT(*)::int AS "blocks",
      COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(r."answeredAt", r."closedAt", ${input.now}) - r."createdAt")) / 60.0), 0)::float8 AS "waitMin"
    FROM "AreaRequest" r
    WHERE r."blocksDelivery" = TRUE
      AND r."payload" ->> 'sku' IS NOT NULL
      AND r."createdAt" >= ${input.from}
      AND r."createdAt" < ${input.to}
    GROUP BY 1, 2, 3, 4
  `;
}

/** Ruta detrás de una incidencia: expediente → entrega → viaje. */
export function blockCauseRouteSql(input: DayWindow & { now: Date }): Prisma.Sql {
  return Prisma.sql`
    SELECT (i."openedAt")::date AS "day",
      'route' AS "causeType",
      t."id" AS "causeKey",
      ('Viaje ' || t."number") AS "causeLabel",
      COUNT(DISTINCT i."id")::int AS "blocks",
      COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(i."resolvedAt", ${input.now}) - i."openedAt")) / 60.0), 0)::float8 AS "waitMin"
    FROM "Incident" i
    JOIN "ObjectRelation" r1
      ON r1."fromType" = 'operational_case'
     AND r1."fromId" = i."caseId"
     AND r1."toType" = 'delivery_order'
     AND r1."validTo" IS NULL
    JOIN "ObjectRelation" r2
      ON r2."fromType" = 'trip'
     AND r2."toType" = 'delivery_order'
     AND r2."toId" = r1."toId"
     AND r2."validTo" IS NULL
    JOIN "Trip" t ON t."id" = r2."fromId"
    WHERE i."openedAt" >= ${input.from}
      AND i."openedAt" < ${input.to}
      AND i."caseId" IS NOT NULL
    GROUP BY 1, 2, 3, 4
  `;
}

/** Cliente detrás de una incidencia (por expediente). */
export function blockCauseCustomerSql(input: DayWindow & { now: Date }): Prisma.Sql {
  return Prisma.sql`
    SELECT (i."openedAt")::date AS "day",
      'customer' AS "causeType",
      LEFT(COALESCE(c."zohoCustomerId", LOWER(c."customerName")), 120) AS "causeKey",
      LEFT(COALESCE(c."customerName", 'Cliente sin nombre'), 120) AS "causeLabel",
      COUNT(*)::int AS "blocks",
      COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(i."resolvedAt", ${input.now}) - i."openedAt")) / 60.0), 0)::float8 AS "waitMin"
    FROM "Incident" i
    JOIN "OperationalCase" c ON c."id" = i."caseId"
    WHERE i."openedAt" >= ${input.from}
      AND i."openedAt" < ${input.to}
      AND (c."customerName" IS NOT NULL OR c."zohoCustomerId" IS NOT NULL)
    GROUP BY 1, 2, 3, 4
  `;
}

/** Las cinco consultas de causas, en el orden en que se escriben. */
export function blockCauseQueries(
  input: DayWindow & { windowFrom: Date; now: Date }
): Prisma.Sql[] {
  return [
    blockCauseWaitReasonSql(input),
    blockCauseVendorSql(input),
    blockCauseProductSql(input),
    blockCauseRouteSql(input),
    blockCauseCustomerSql(input),
  ];
}
