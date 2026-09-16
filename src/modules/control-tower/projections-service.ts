import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { AREA_LABELS, isAreaKey } from '@/modules/operations/types';
import { assertControlTowerAccess } from './control-tower-service';
import { checkConformance, stepLabels, toConformanceDefinition } from './conformance';
import {
  affectedCaseIdsSql,
  blockCauseQueries,
  caseActivationsSql,
  caseSequenceSql,
  handoffRequestsSql,
  handoffWorkItemsSql,
  maxEventIdSql,
  stepCompletionMetricsSql,
  stepReworkSql,
  stepStartedSql,
  stepWaitSql,
  type AffectedCaseRow,
  type BlockCauseRow,
  type CaseActivationRow,
  type CaseSequenceRow,
  type DayWindow,
  type HandoffRow,
  type MaxEventIdRow,
  type StepCompletionRow,
  type StepReworkRow,
  type StepStartedRow,
  type StepWaitRow,
} from './projections-sql';
import {
  countRework,
  rankBottlenecks,
  summarizeVariants,
  variantHash,
  type BottleneckRow,
  type StepMetricRow,
  type VariantCaseRow,
  type VariantSummary,
} from './variants';

/**
 * Proyecciones de inteligencia de procesos (plan 7.9). SÓLO SERVIDOR.
 *
 * El job `ct.projections_refresh` llama `refreshProjections()` cada 15 minutos.
 * Cada proyección lleva su propia marca de agua (`CtProjectionWatermark`) y es
 * IDEMPOTENTE: recalcular un día o un expediente dos veces deja el mismo
 * resultado, porque todo se escribe con `upsert` sobre su llave natural.
 *
 * Por qué la marca de agua no es sólo un id: `OperationalEvent.id` se asigna al
 * INSERTAR, no al confirmar, así que una transacción lenta puede confirmar un id
 * menor que el que ya leímos. Cada corrida relee además por `recordedAt` una
 * ventana hacia atrás (`REPLAY_WINDOW_MS`) y guarda como `lastRunAt` la hora de
 * INICIO de la corrida, nunca la de fin.
 *
 * Los días se recalculan completos (no por diferencias): un día que recibió un
 * evento nuevo se vuelve a agregar entero, de modo que un percentil nunca queda
 * a medias.
 */

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

export const PROJECTION_KEYS = ['variants', 'step_metrics', 'handoffs', 'block_causes'] as const;
export type ProjectionKey = (typeof PROJECTION_KEYS)[number];

export const PROJECTION_LABELS: Record<ProjectionKey, string> = {
  variants: 'Variantes de proceso',
  step_metrics: 'Métricas por paso',
  handoffs: 'Traspasos entre áreas',
  block_causes: 'Causas de bloqueo',
};

const MINUTE = 60_000;
const DAY_MS = 24 * 60 * MINUTE;

/** Relectura por `recordedAt` para no perder transacciones lentas. */
const REPLAY_WINDOW_MS = 10 * MINUTE;

/** Días que se recalculan hacia atrás en cada corrida incremental. */
const INCREMENTAL_DAYS = 2;

/** Días que abarca una reconstrucción completa. */
export const FULL_REBUILD_DAYS = 180;

/** Expedientes por corrida incremental (una reconstrucción completa los recorre todos por lotes). */
const AFFECTED_CASE_LIMIT = 5_000;

/** Expedientes por lote de consulta (el `IN (...)` no crece sin control). */
const CASE_CHUNK = 200;

/** Ventana de lectura hacia atrás de las esperas: una espera larga se cierra días después. */
const WAIT_LOOKBACK_DAYS = 30;

/** Tope de filas por escritura de proyección diaria. */
const DAILY_WRITE_LIMIT = 20_000;

// ---------------------------------------------------------------------------
// Utilidades de fecha
// ---------------------------------------------------------------------------

/** Medianoche UTC del día de `value` (el mismo calendario que usan las consultas: `(columna)::date`). */
export function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

/** Ventana de días [from, to) que hay que recalcular. */
export function projectionWindow(input: {
  now: Date;
  lastRunAt: Date | null;
  full: boolean;
}): DayWindow {
  const to = addDays(startOfUtcDay(input.now), 1);
  if (input.full || !input.lastRunAt) {
    return { from: addDays(startOfUtcDay(input.now), -FULL_REBUILD_DAYS), to };
  }
  const since = startOfUtcDay(new Date(input.lastRunAt.getTime() - REPLAY_WINDOW_MS));
  const from = addDays(since, -INCREMENTAL_DAYS);
  return { from: from.getTime() < to.getTime() ? from : addDays(to, -1), to };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toFloatOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function toDay(value: unknown): Date | null {
  if (value instanceof Date) return startOfUtcDay(value);
  if (typeof value === 'string') {
    const parsed = new Date(value.length <= 10 ? `${value}T00:00:00.000Z` : value);
    return Number.isNaN(parsed.getTime()) ? null : startOfUtcDay(parsed);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Marca de agua
// ---------------------------------------------------------------------------

export interface WatermarkState {
  key: string;
  lastEventId: bigint;
  lastRunAt: Date | null;
  lastDurationMs: number | null;
}

export async function readWatermark(key: ProjectionKey): Promise<WatermarkState> {
  const row = await prisma.ctProjectionWatermark.findUnique({ where: { key } });
  return {
    key,
    lastEventId: row ? BigInt(row.lastEventId ?? 0) : BigInt(0),
    lastRunAt: row?.lastRunAt ?? null,
    lastDurationMs: row?.lastDurationMs ?? null,
  };
}

async function writeWatermark(
  key: ProjectionKey,
  input: { lastEventId: bigint; startedAt: Date; durationMs: number }
): Promise<void> {
  const data = {
    lastEventId: input.lastEventId,
    lastRunAt: input.startedAt,
    lastDurationMs: input.durationMs,
  };
  await prisma.ctProjectionWatermark.upsert({
    where: { key },
    create: { key, ...data },
    update: data,
  });
}

/** Último id de la bitácora (0 si aún no hay eventos). */
async function currentMaxEventId(): Promise<bigint> {
  const rows = await prisma.$queryRaw<MaxEventIdRow[]>(maxEventIdSql());
  const raw = rows[0]?.maxId;
  if (raw === null || raw === undefined) return BigInt(0);
  return typeof raw === 'bigint' ? raw : BigInt(Math.trunc(Number(raw)));
}

// ---------------------------------------------------------------------------
// Proyección: variantes
// ---------------------------------------------------------------------------

interface CaseFacts {
  id: string;
  caseNumber: string;
  status: string;
  processVersionId: string;
  openedAt: Date;
  closedAt: Date | null;
  cancelledAt: Date | null;
}

/** Expedientes tocados desde la marca de agua (o todos, en reconstrucción completa). */
async function affectedCaseIds(input: {
  watermark: WatermarkState;
  now: Date;
  full: boolean;
}): Promise<string[]> {
  if (input.full) {
    const rows = await prisma.operationalCase.findMany({
      where: { openedAt: { gte: addDays(startOfUtcDay(input.now), -FULL_REBUILD_DAYS) } },
      select: { id: true },
      orderBy: { openedAt: 'asc' },
    });
    return rows.map((row) => row.id);
  }
  const since = new Date(
    (input.watermark.lastRunAt?.getTime() ?? input.now.getTime() - DAY_MS) - REPLAY_WINDOW_MS
  );
  const rows = await prisma.$queryRaw<AffectedCaseRow[]>(
    affectedCaseIdsSql({
      lastEventId: input.watermark.lastEventId,
      since,
      limit: AFFECTED_CASE_LIMIT,
    })
  );
  return rows.map((row) => row.caseId).filter((id): id is string => typeof id === 'string' && !!id);
}

export interface VariantsRefreshResult {
  cases: number;
  written: number;
}

/**
 * Recalcula `CtCaseVariant` de los expedientes tocados: secuencia observada,
 * hash estable, conformidad contra su propia versión del proceso y retrabajo.
 */
export async function refreshVariants(input: {
  caseIds: readonly string[];
}): Promise<VariantsRefreshResult> {
  const ids = [...new Set(input.caseIds)].filter(Boolean);
  if (ids.length === 0) return { cases: 0, written: 0 };

  let written = 0;
  for (const batch of chunk(ids, CASE_CHUNK)) {
    const [cases, sequences, activations] = await Promise.all([
      prisma.operationalCase.findMany({
        where: { id: { in: [...batch] } },
        select: {
          id: true,
          caseNumber: true,
          status: true,
          processVersionId: true,
          openedAt: true,
          closedAt: true,
          cancelledAt: true,
        },
      }) as Promise<CaseFacts[]>,
      prisma.$queryRaw<CaseSequenceRow[]>(caseSequenceSql(batch)),
      prisma.$queryRaw<CaseActivationRow[]>(caseActivationsSql(batch)),
    ]);
    if (cases.length === 0) continue;

    const versionIds = [...new Set(cases.map((row) => row.processVersionId).filter(Boolean))];
    const versions = versionIds.length
      ? await prisma.processVersion.findMany({
          where: { id: { in: versionIds } },
          select: { id: true, processKey: true, version: true, definition: true },
        })
      : [];
    const versionById = new Map(versions.map((row) => [row.id, row]));
    const sequenceByCase = new Map(sequences.map((row) => [row.caseId, row]));
    const activationsByCase = new Map<string, CaseActivationRow[]>();
    for (const row of activations) {
      const list = activationsByCase.get(row.caseId);
      if (list) list.push(row);
      else activationsByCase.set(row.caseId, [row]);
    }

    for (const record of cases) {
      const version = versionById.get(record.processVersionId);
      const definition = version ? toConformanceDefinition(version.definition) : null;
      const sequenceRow = sequenceByCase.get(record.id);
      const sequence = (sequenceRow?.sequence ?? []).filter(
        (key): key is string => typeof key === 'string' && key.length > 0
      );
      const scopes = sequenceRow?.scopes ?? [];
      const observed = sequence.map((stepKey, index) => ({
        stepKey,
        scopeKey: typeof scopes[index] === 'string' ? scopes[index] : '',
      }));
      const closedAt = record.closedAt ?? record.cancelledAt ?? null;
      const closed =
        Boolean(closedAt) || record.status === 'closed' || record.status === 'cancelled';
      const conformance = definition
        ? checkConformance(definition, observed, { closed })
        : { conformant: true, violations: [] };

      const rework = countRework(
        (activationsByCase.get(record.id) ?? []).flatMap((row) =>
          Array.from({ length: Math.max(toNumber(row.activations), 0) }, () => ({
            stepKey: row.stepKey,
            scopeKey: row.scopeKey ?? '',
          }))
        )
      );

      const durationMin = closedAt
        ? Math.max(0, Math.round((closedAt.getTime() - record.openedAt.getTime()) / MINUTE))
        : null;

      const data = {
        processKey: version?.processKey ?? 'desconocido',
        processVersion: version?.version ?? 0,
        variantHash: variantHash(sequence),
        sequence,
        stepCount: sequence.length,
        durationMin,
        conformant: conformance.conformant,
        violations: conformance.violations as unknown as Prisma.InputJsonValue,
        reworkCount: rework.count,
        computedAt: new Date(),
      };
      await prisma.ctCaseVariant.upsert({
        where: { caseId: record.id },
        create: { caseId: record.id, ...data },
        update: data,
      });
      written += 1;
    }
  }
  return { cases: ids.length, written };
}

// ---------------------------------------------------------------------------
// Proyección: métricas por paso
// ---------------------------------------------------------------------------

interface StepMetricAccumulator {
  day: Date;
  processKey: string;
  stepKey: string;
  areaKey: string;
  started: number;
  completed: number;
  p50ActiveMin: number | null;
  p90ActiveMin: number | null;
  avgActiveMin: number | null;
  p50WaitMin: number | null;
  p90WaitMin: number | null;
  breached: number;
  reworked: number;
}

function metricKey(day: Date, processKey: string, stepKey: string): string {
  return `${day.toISOString().slice(0, 10)}|${processKey}|${stepKey}`;
}

function ensureMetric(
  map: Map<string, StepMetricAccumulator>,
  day: Date,
  processKey: string,
  stepKey: string
): StepMetricAccumulator {
  const key = metricKey(day, processKey, stepKey);
  let row = map.get(key);
  if (!row) {
    row = {
      day,
      processKey,
      stepKey,
      areaKey: '',
      started: 0,
      completed: 0,
      p50ActiveMin: null,
      p90ActiveMin: null,
      avgActiveMin: null,
      p50WaitMin: null,
      p90WaitMin: null,
      breached: 0,
      reworked: 0,
    };
    map.set(key, row);
  }
  return row;
}

export interface DailyRefreshResult {
  days: number;
  written: number;
}

/** Recalcula `CtStepMetricDaily` para la ventana completa (el día entero, no la diferencia). */
export async function refreshStepMetrics(window: DayWindow): Promise<DailyRefreshResult> {
  const waitWindow = {
    ...window,
    windowFrom: addDays(window.from, -WAIT_LOOKBACK_DAYS),
  };
  const [completions, starts, reworks, waits] = await Promise.all([
    prisma.$queryRaw<StepCompletionRow[]>(stepCompletionMetricsSql(window)),
    prisma.$queryRaw<StepStartedRow[]>(stepStartedSql(window)),
    prisma.$queryRaw<StepReworkRow[]>(stepReworkSql(window)),
    prisma.$queryRaw<StepWaitRow[]>(stepWaitSql(waitWindow)),
  ]);

  const map = new Map<string, StepMetricAccumulator>();
  for (const row of completions) {
    const day = toDay(row.day);
    if (!day || !row.processKey || !row.stepKey) continue;
    const metric = ensureMetric(map, day, row.processKey, row.stepKey);
    metric.areaKey = row.areaKey || metric.areaKey;
    metric.completed += toNumber(row.completed);
    metric.p50ActiveMin = toFloatOrNull(row.p50ActiveMin);
    metric.p90ActiveMin = toFloatOrNull(row.p90ActiveMin);
    metric.avgActiveMin = toFloatOrNull(row.avgActiveMin);
    metric.breached += toNumber(row.breached);
  }
  for (const row of starts) {
    const day = toDay(row.day);
    if (!day || !row.processKey || !row.stepKey) continue;
    const metric = ensureMetric(map, day, row.processKey, row.stepKey);
    metric.areaKey = metric.areaKey || row.areaKey || '';
    metric.started += toNumber(row.started);
  }
  for (const row of reworks) {
    const day = toDay(row.day);
    if (!day || !row.processKey || !row.stepKey) continue;
    const metric = ensureMetric(map, day, row.processKey, row.stepKey);
    metric.reworked += toNumber(row.reworked);
  }
  for (const row of waits) {
    const day = toDay(row.day);
    if (!day || !row.processKey || !row.stepKey) continue;
    const metric = ensureMetric(map, day, row.processKey, row.stepKey);
    metric.p50WaitMin = toFloatOrNull(row.p50WaitMin);
    metric.p90WaitMin = toFloatOrNull(row.p90WaitMin);
  }

  const rows = [...map.values()].slice(0, DAILY_WRITE_LIMIT);
  for (const row of rows) {
    const data = {
      areaKey: row.areaKey || 'administracion',
      started: row.started,
      completed: row.completed,
      p50ActiveMin: row.p50ActiveMin,
      p90ActiveMin: row.p90ActiveMin,
      avgActiveMin: row.avgActiveMin,
      p50WaitMin: row.p50WaitMin,
      p90WaitMin: row.p90WaitMin,
      breached: row.breached,
      reworked: row.reworked,
    };
    await prisma.ctStepMetricDaily.upsert({
      where: {
        day_processKey_stepKey: {
          day: row.day,
          processKey: row.processKey,
          stepKey: row.stepKey,
        },
      },
      create: { day: row.day, processKey: row.processKey, stepKey: row.stepKey, ...data },
      update: data,
    });
  }
  return { days: new Set(rows.map((row) => row.day.getTime())).size, written: rows.length };
}

// ---------------------------------------------------------------------------
// Proyección: traspasos
// ---------------------------------------------------------------------------

/** Recalcula `CtHandoffDaily` (solicitudes entre áreas y reasignaciones de trabajo). */
export async function refreshHandoffs(window: DayWindow): Promise<DailyRefreshResult> {
  const [requests, workItems] = await Promise.all([
    prisma.$queryRaw<HandoffRow[]>(handoffRequestsSql(window)),
    prisma.$queryRaw<HandoffRow[]>(handoffWorkItemsSql(window)),
  ]);

  const entries: Array<{ kind: 'request' | 'workitem'; row: HandoffRow }> = [
    ...requests.map((row) => ({ kind: 'request' as const, row })),
    ...workItems.map((row) => ({ kind: 'workitem' as const, row })),
  ];

  let written = 0;
  const days = new Set<number>();
  for (const entry of entries.slice(0, DAILY_WRITE_LIMIT)) {
    const day = toDay(entry.row.day);
    if (!day || !entry.row.fromAreaKey || !entry.row.toAreaKey) continue;
    days.add(day.getTime());
    const data = {
      count: toNumber(entry.row.count),
      p50ResponseMin: toFloatOrNull(entry.row.p50ResponseMin),
      p90ResponseMin: toFloatOrNull(entry.row.p90ResponseMin),
      expired: toNumber(entry.row.expired),
    };
    await prisma.ctHandoffDaily.upsert({
      where: {
        day_fromAreaKey_toAreaKey_kind: {
          day,
          fromAreaKey: entry.row.fromAreaKey,
          toAreaKey: entry.row.toAreaKey,
          kind: entry.kind,
        },
      },
      create: {
        day,
        fromAreaKey: entry.row.fromAreaKey,
        toAreaKey: entry.row.toAreaKey,
        kind: entry.kind,
        ...data,
      },
      update: data,
    });
    written += 1;
  }
  return { days: days.size, written };
}

// ---------------------------------------------------------------------------
// Proyección: causas de bloqueo
// ---------------------------------------------------------------------------

/** Recalcula `CtBlockCauseDaily` con las cinco consultas de causas. */
export async function refreshBlockCauses(
  window: DayWindow,
  options: { now: Date }
): Promise<DailyRefreshResult> {
  const queries = blockCauseQueries({
    ...window,
    windowFrom: addDays(window.from, -WAIT_LOOKBACK_DAYS),
    now: options.now,
  });
  const results = await Promise.all(queries.map((sql) => prisma.$queryRaw<BlockCauseRow[]>(sql)));

  const merged = new Map<
    string,
    {
      day: Date;
      causeType: string;
      causeKey: string;
      causeLabel: string;
      blocks: number;
      waitMin: number;
    }
  >();
  for (const rows of results) {
    for (const row of rows) {
      const day = toDay(row.day);
      const causeType = typeof row.causeType === 'string' ? row.causeType : '';
      const causeKey = typeof row.causeKey === 'string' ? row.causeKey.slice(0, 120) : '';
      if (!day || !causeType || !causeKey) continue;
      const key = `${day.toISOString().slice(0, 10)}|${causeType}|${causeKey}`;
      const current = merged.get(key);
      const blocks = toNumber(row.blocks);
      const waitMin = toNumber(row.waitMin);
      if (current) {
        current.blocks += blocks;
        current.waitMin += waitMin;
        continue;
      }
      merged.set(key, {
        day,
        causeType,
        causeKey,
        causeLabel: (typeof row.causeLabel === 'string' && row.causeLabel.trim()) || causeKey,
        blocks,
        waitMin,
      });
    }
  }

  const rows = [...merged.values()].slice(0, DAILY_WRITE_LIMIT);
  for (const row of rows) {
    const data = {
      causeLabel: row.causeLabel.slice(0, 120),
      blocks: row.blocks,
      waitMin: Math.round(row.waitMin * 100) / 100,
    };
    await prisma.ctBlockCauseDaily.upsert({
      where: {
        day_causeType_causeKey: {
          day: row.day,
          causeType: row.causeType,
          causeKey: row.causeKey,
        },
      },
      create: { day: row.day, causeType: row.causeType, causeKey: row.causeKey, ...data },
      update: data,
    });
  }
  return { days: new Set(rows.map((row) => row.day.getTime())).size, written: rows.length };
}

// ---------------------------------------------------------------------------
// Orquestación
// ---------------------------------------------------------------------------

export interface ProjectionRunResult {
  key: ProjectionKey;
  ok: boolean;
  durationMs: number;
  written: number;
  detail: string;
  error?: string;
}

export interface RefreshProjectionsResult {
  startedAt: string;
  durationMs: number;
  full: boolean;
  window: { from: string; to: string };
  runs: ProjectionRunResult[];
  failed: number;
}

export interface RefreshProjectionsOptions {
  now?: Date;
  /** Reconstrucción completa (desde el panel de administración). */
  full?: boolean;
  /** Sólo estas proyecciones. */
  keys?: readonly ProjectionKey[];
  /** El job aborta entre proyecciones cuando se cancela. */
  signal?: AbortSignal;
}

/**
 * Corre las cuatro proyecciones. Una que falle NO detiene a las demás y su
 * marca de agua NO avanza, así que la siguiente corrida la vuelve a intentar
 * desde donde se quedó.
 */
export async function refreshProjections(
  options: RefreshProjectionsOptions = {}
): Promise<RefreshProjectionsResult> {
  const now = options.now ?? new Date();
  const full = options.full === true;
  const startedAt = new Date();
  const requested = new Set<ProjectionKey>(options.keys ?? PROJECTION_KEYS);
  const runs: ProjectionRunResult[] = [];
  /** La ventana más ancha que se recalculó de verdad (lo que se reporta). */
  let widest: DayWindow | null = null;

  const maxEventId = await currentMaxEventId();

  const run = async (
    key: ProjectionKey,
    execute: (
      watermark: WatermarkState,
      window: DayWindow
    ) => Promise<{ written: number; detail: string }>
  ): Promise<void> => {
    if (!requested.has(key)) return;
    if (options.signal?.aborted) {
      runs.push({
        key,
        ok: false,
        durationMs: 0,
        written: 0,
        detail: 'Cancelada',
        error: 'aborted',
      });
      return;
    }
    const begunAt = Date.now();
    try {
      const watermark = await readWatermark(key);
      const window = projectionWindow({ now, lastRunAt: watermark.lastRunAt, full });
      if (!widest || window.from.getTime() < widest.from.getTime()) widest = window;
      const outcome = await execute(watermark, window);
      const durationMs = Date.now() - begunAt;
      await writeWatermark(key, { lastEventId: maxEventId, startedAt, durationMs });
      runs.push({ key, ok: true, durationMs, written: outcome.written, detail: outcome.detail });
    } catch (error) {
      runs.push({
        key,
        ok: false,
        durationMs: Date.now() - begunAt,
        written: 0,
        detail: 'No se pudo recalcular',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await run('variants', async (watermark) => {
    const caseIds = await affectedCaseIds({ watermark, now, full });
    const result = await refreshVariants({ caseIds });
    return {
      written: result.written,
      detail: `${result.written} expediente(s) de ${result.cases} tocado(s)`,
    };
  });
  await run('step_metrics', async (_watermark, window) => {
    const result = await refreshStepMetrics(window);
    return {
      written: result.written,
      detail: `${result.written} fila(s) en ${result.days} día(s)`,
    };
  });
  await run('handoffs', async (_watermark, window) => {
    const result = await refreshHandoffs(window);
    return {
      written: result.written,
      detail: `${result.written} fila(s) en ${result.days} día(s)`,
    };
  });
  await run('block_causes', async (_watermark, window) => {
    const result = await refreshBlockCauses(window, { now });
    return {
      written: result.written,
      detail: `${result.written} fila(s) en ${result.days} día(s)`,
    };
  });

  const reported: DayWindow = widest ?? projectionWindow({ now, lastRunAt: startedAt, full });
  return {
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    full,
    window: { from: reported.from.toISOString(), to: reported.to.toISOString() },
    runs,
    failed: runs.filter((entry) => !entry.ok).length,
  };
}

/** Reconstrucción bajo demanda desde la Torre de Control. */
export async function rebuildProjections(
  actor: CurrentUser,
  options: { full?: boolean; keys?: readonly ProjectionKey[]; now?: Date } = {}
): Promise<RefreshProjectionsResult> {
  assertControlTowerAccess(actor);
  return refreshProjections({
    ...(options.now ? { now: options.now } : {}),
    full: options.full !== false,
    ...(options.keys ? { keys: options.keys } : {}),
  });
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

export interface ProjectionRangeInput {
  processKey?: string | null;
  from?: Date | null;
  to?: Date | null;
  areaKey?: string | null;
  limit?: number | null;
}

function rangeOf(input: ProjectionRangeInput, now: Date): DayWindow {
  const to = input.to ? addDays(startOfUtcDay(input.to), 1) : addDays(startOfUtcDay(now), 1);
  const from = input.from ? startOfUtcDay(input.from) : addDays(to, -30);
  return { from: from.getTime() < to.getTime() ? from : addDays(to, -1), to };
}

/** Tope de expedientes leídos por la tabla de variantes. */
const VARIANT_CASE_LIMIT = 5_000;

export interface VariantsView {
  processKey: string;
  from: string;
  to: string;
  cases: number;
  conformantPct: number;
  reworkPct: number;
  variants: VariantSummary[];
  /** Expedientes con al menos una desviación, para la lista de retrabajo. */
  nonConformant: Array<{
    caseId: string;
    caseNumber: string | null;
    customerName: string | null;
    variantHash: string;
    violations: Array<{ kind: string; stepKey: string; detail: string }>;
    reworkCount: number;
  }>;
  truncated: boolean;
}

/** Variantes observadas en un rango (agrupadas por hash) y los expedientes desviados. */
export async function listVariants(
  actor: CurrentUser,
  input: ProjectionRangeInput = {},
  options: { now?: Date } = {}
): Promise<VariantsView> {
  assertControlTowerAccess(actor);
  const now = options.now ?? new Date();
  const window = rangeOf(input, now);

  const cases = await prisma.operationalCase.findMany({
    where: { openedAt: { gte: window.from, lt: window.to } },
    select: { id: true, caseNumber: true, customerName: true, processVersionId: true },
    orderBy: { openedAt: 'desc' },
    take: VARIANT_CASE_LIMIT + 1,
  });
  const truncated = cases.length > VARIANT_CASE_LIMIT;
  const visible = truncated ? cases.slice(0, VARIANT_CASE_LIMIT) : cases;
  if (visible.length === 0) {
    return {
      processKey: input.processKey ?? 'sales_fulfillment',
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      cases: 0,
      conformantPct: 0,
      reworkPct: 0,
      variants: [],
      nonConformant: [],
      truncated: false,
    };
  }

  const variantRows = await prisma.ctCaseVariant.findMany({
    where: {
      caseId: { in: visible.map((row) => row.id) },
      ...(input.processKey ? { processKey: input.processKey } : {}),
    },
    select: {
      caseId: true,
      processKey: true,
      variantHash: true,
      sequence: true,
      durationMin: true,
      conformant: true,
      violations: true,
      reworkCount: true,
    },
  });

  const labels = await processStepLabels(visible[0]?.processVersionId ?? null);
  const rows: VariantCaseRow[] = variantRows.map((row) => ({
    caseId: row.caseId,
    variantHash: row.variantHash,
    sequence: row.sequence ?? [],
    durationMin: row.durationMin ?? null,
    conformant: row.conformant,
    reworkCount: row.reworkCount ?? 0,
  }));
  const caseById = new Map(visible.map((row) => [row.id, row]));
  const conformant = rows.filter((row) => row.conformant).length;
  const rework = rows.filter((row) => row.reworkCount > 0).length;

  return {
    processKey: input.processKey ?? variantRows[0]?.processKey ?? 'sales_fulfillment',
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    cases: rows.length,
    conformantPct: rows.length === 0 ? 0 : Math.round((conformant / rows.length) * 1000) / 10,
    reworkPct: rows.length === 0 ? 0 : Math.round((rework / rows.length) * 1000) / 10,
    variants: summarizeVariants(rows, labels),
    nonConformant: variantRows
      .filter((row) => !row.conformant || (row.reworkCount ?? 0) > 0)
      .slice(0, 100)
      .map((row) => ({
        caseId: row.caseId,
        caseNumber: caseById.get(row.caseId)?.caseNumber ?? null,
        customerName: caseById.get(row.caseId)?.customerName ?? null,
        variantHash: row.variantHash,
        violations: parseViolations(row.violations),
        reworkCount: row.reworkCount ?? 0,
      })),
    truncated,
  };
}

function parseViolations(
  value: Prisma.JsonValue | null | undefined
): Array<{ kind: string; stepKey: string; detail: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ kind: string; stepKey: string; detail: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    out.push({
      kind: typeof raw.kind === 'string' ? raw.kind : 'desviación',
      stepKey: typeof raw.stepKey === 'string' ? raw.stepKey : '',
      detail: typeof raw.detail === 'string' ? raw.detail : '',
    });
  }
  return out;
}

/** Etiquetas de paso de la versión de proceso (para las tablas y el visor). */
export async function processStepLabels(
  processVersionId: string | null
): Promise<Map<string, string>> {
  if (!processVersionId) return new Map();
  const version = await prisma.processVersion.findUnique({
    where: { id: processVersionId },
    select: { definition: true },
  });
  const definition = version ? toConformanceDefinition(version.definition) : null;
  return definition ? stepLabels(definition) : new Map();
}

export interface StepMetricsView {
  from: string;
  to: string;
  steps: StepMetricRow[];
  bottlenecks: BottleneckRow[];
  daily: Array<{
    day: string;
    stepKey: string;
    areaKey: string;
    started: number;
    completed: number;
    p50ActiveMin: number | null;
    p90WaitMin: number | null;
    breached: number;
  }>;
}

/** Métricas por paso del rango, ya agregadas, más el ranking de cuellos de botella. */
export async function listStepMetrics(
  actor: CurrentUser,
  input: ProjectionRangeInput = {},
  options: { now?: Date } = {}
): Promise<StepMetricsView> {
  assertControlTowerAccess(actor);
  const now = options.now ?? new Date();
  const window = rangeOf(input, now);
  const rows = await prisma.ctStepMetricDaily.findMany({
    where: {
      day: { gte: window.from, lt: window.to },
      ...(input.processKey ? { processKey: input.processKey } : {}),
      ...(input.areaKey ? { areaKey: input.areaKey } : {}),
    },
    orderBy: [{ day: 'asc' }, { stepKey: 'asc' }],
    take: DAILY_WRITE_LIMIT,
  });

  const byStep = new Map<string, StepMetricRow>();
  for (const row of rows) {
    const current = byStep.get(row.stepKey);
    if (!current) {
      byStep.set(row.stepKey, {
        stepKey: row.stepKey,
        areaKey: row.areaKey,
        started: row.started,
        completed: row.completed,
        p50ActiveMin: row.p50ActiveMin,
        p90ActiveMin: row.p90ActiveMin,
        p50WaitMin: row.p50WaitMin,
        p90WaitMin: row.p90WaitMin,
        breached: row.breached,
        reworked: row.reworked,
      });
      continue;
    }
    current.started += row.started;
    current.completed += row.completed;
    current.breached += row.breached;
    current.reworked += row.reworked;
    current.p50ActiveMin = maxOrNull(current.p50ActiveMin, row.p50ActiveMin);
    current.p90ActiveMin = maxOrNull(current.p90ActiveMin, row.p90ActiveMin);
    current.p50WaitMin = maxOrNull(current.p50WaitMin, row.p50WaitMin);
    current.p90WaitMin = maxOrNull(current.p90WaitMin, row.p90WaitMin);
  }

  const steps = [...byStep.values()].sort((a, b) => a.stepKey.localeCompare(b.stepKey));
  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    steps,
    bottlenecks: rankBottlenecks(steps),
    daily: rows.map((row) => ({
      day: row.day.toISOString().slice(0, 10),
      stepKey: row.stepKey,
      areaKey: row.areaKey,
      started: row.started,
      completed: row.completed,
      p50ActiveMin: row.p50ActiveMin,
      p90WaitMin: row.p90WaitMin,
      breached: row.breached,
    })),
  };
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

export interface HandoffCell {
  fromAreaKey: string;
  fromLabel: string;
  toAreaKey: string;
  toLabel: string;
  count: number;
  expired: number;
  p50ResponseMin: number | null;
  p90ResponseMin: number | null;
}

export interface HandoffsView {
  from: string;
  to: string;
  kind: 'request' | 'workitem' | 'all';
  cells: HandoffCell[];
  areas: Array<{ key: string; label: string }>;
  total: number;
  expired: number;
}

const areaLabel = (key: string): string => (isAreaKey(key) ? AREA_LABELS[key] : key);

/** Matriz área × área de traspasos del rango. */
export async function listHandoffs(
  actor: CurrentUser,
  input: ProjectionRangeInput & { kind?: 'request' | 'workitem' | 'all' } = {},
  options: { now?: Date } = {}
): Promise<HandoffsView> {
  assertControlTowerAccess(actor);
  const now = options.now ?? new Date();
  const window = rangeOf(input, now);
  const kind = input.kind ?? 'all';
  const rows = await prisma.ctHandoffDaily.findMany({
    where: {
      day: { gte: window.from, lt: window.to },
      ...(kind === 'all' ? {} : { kind }),
    },
    take: DAILY_WRITE_LIMIT,
  });

  const cells = new Map<string, HandoffCell>();
  const areas = new Set<string>();
  let total = 0;
  let expired = 0;
  for (const row of rows) {
    areas.add(row.fromAreaKey);
    areas.add(row.toAreaKey);
    const key = `${row.fromAreaKey}>${row.toAreaKey}`;
    const current = cells.get(key);
    total += row.count;
    expired += row.expired;
    if (!current) {
      cells.set(key, {
        fromAreaKey: row.fromAreaKey,
        fromLabel: areaLabel(row.fromAreaKey),
        toAreaKey: row.toAreaKey,
        toLabel: areaLabel(row.toAreaKey),
        count: row.count,
        expired: row.expired,
        p50ResponseMin: row.p50ResponseMin,
        p90ResponseMin: row.p90ResponseMin,
      });
      continue;
    }
    current.count += row.count;
    current.expired += row.expired;
    current.p50ResponseMin = maxOrNull(current.p50ResponseMin, row.p50ResponseMin);
    current.p90ResponseMin = maxOrNull(current.p90ResponseMin, row.p90ResponseMin);
  }

  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    kind,
    cells: [...cells.values()].sort((a, b) => b.count - a.count),
    areas: [...areas].sort().map((key) => ({ key, label: areaLabel(key) })),
    total,
    expired,
  };
}

export interface CauseRow {
  causeType: string;
  causeTypeLabel: string;
  causeKey: string;
  causeLabel: string;
  blocks: number;
  waitMin: number;
  avgWaitMin: number;
}

export const CAUSE_TYPE_LABELS: Record<string, string> = {
  vendor: 'Proveedor',
  product: 'Producto',
  route: 'Ruta',
  customer: 'Cliente',
  wait_reason: 'Motivo de espera',
};

export interface CausesView {
  from: string;
  to: string;
  causes: CauseRow[];
  byType: Array<{ causeType: string; label: string; blocks: number; waitMin: number }>;
}

/** Causas de bloqueo del rango, de la que más espera acumula a la que menos. */
export async function listCauses(
  actor: CurrentUser,
  input: ProjectionRangeInput & { causeType?: string | null } = {},
  options: { now?: Date } = {}
): Promise<CausesView> {
  assertControlTowerAccess(actor);
  const now = options.now ?? new Date();
  const window = rangeOf(input, now);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = await prisma.ctBlockCauseDaily.findMany({
    where: {
      day: { gte: window.from, lt: window.to },
      ...(input.causeType ? { causeType: input.causeType } : {}),
    },
    take: DAILY_WRITE_LIMIT,
  });

  const merged = new Map<string, CauseRow>();
  const byType = new Map<string, { blocks: number; waitMin: number }>();
  for (const row of rows) {
    const key = `${row.causeType}|${row.causeKey}`;
    const current = merged.get(key);
    if (current) {
      current.blocks += row.blocks;
      current.waitMin += row.waitMin;
    } else {
      merged.set(key, {
        causeType: row.causeType,
        causeTypeLabel: CAUSE_TYPE_LABELS[row.causeType] ?? row.causeType,
        causeKey: row.causeKey,
        causeLabel: row.causeLabel,
        blocks: row.blocks,
        waitMin: row.waitMin,
        avgWaitMin: 0,
      });
    }
    const type = byType.get(row.causeType) ?? { blocks: 0, waitMin: 0 };
    type.blocks += row.blocks;
    type.waitMin += row.waitMin;
    byType.set(row.causeType, type);
  }

  const causes = [...merged.values()]
    .map((row) => ({
      ...row,
      waitMin: Math.round(row.waitMin),
      avgWaitMin: row.blocks === 0 ? 0 : Math.round(row.waitMin / row.blocks),
    }))
    .sort((a, b) => b.waitMin - a.waitMin || b.blocks - a.blocks)
    .slice(0, limit);

  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    causes,
    byType: [...byType.entries()]
      .map(([causeType, value]) => ({
        causeType,
        label: CAUSE_TYPE_LABELS[causeType] ?? causeType,
        blocks: value.blocks,
        waitMin: Math.round(value.waitMin),
      }))
      .sort((a, b) => b.waitMin - a.waitMin),
  };
}

export interface ProjectionStatusRow {
  key: ProjectionKey;
  label: string;
  lastRunAt: string | null;
  minutesAgo: number | null;
  lastDurationMs: number | null;
  stale: boolean;
}

/** Frescura de las cuatro proyecciones (lo que muestra el pie del explorador). */
export async function getProjectionStatus(
  actor: CurrentUser,
  options: { now?: Date } = {}
): Promise<ProjectionStatusRow[]> {
  assertControlTowerAccess(actor);
  const now = options.now ?? new Date();
  const rows = await prisma.ctProjectionWatermark.findMany({
    where: { key: { in: [...PROJECTION_KEYS] } },
  });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return PROJECTION_KEYS.map((key) => {
    const row = byKey.get(key);
    const minutesAgo = row ? Math.round((now.getTime() - row.lastRunAt.getTime()) / MINUTE) : null;
    return {
      key,
      label: PROJECTION_LABELS[key],
      lastRunAt: row ? row.lastRunAt.toISOString() : null,
      minutesAgo,
      lastDurationMs: row?.lastDurationMs ?? null,
      stale: minutesAgo === null || minutesAgo > 60,
    };
  });
}
