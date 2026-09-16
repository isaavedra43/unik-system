import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { AREA_REQUEST_OPEN_STATUSES, WORK_ITEM_OPEN_STATUSES } from '@/modules/operations/types';
import { loadDefaultAreaDashboard } from './area-dashboard-default';
import { AREA_LIST, type AreaMeta, type AreaWorkspaceKey } from './area-registry';
import type { AreaDashboardPayload } from './area-server-registry';
import { getAreaServer } from './area-server-registry';
import {
  DASHBOARD_SNAPSHOT_TTL_MS,
  applyLiveTiles,
  isSnapshotFresh,
  uncoveredLiveTileIds,
  type LiveTilePatch,
} from './dashboard-model';
import { ensureAreaRegistrations } from './register-all';
import { assertAreaAccess } from './work-rows-service';

/**
 * Cache of the area panels (plan 7.3). SERVER ONLY.
 *
 * How a panel answers in under two seconds even cold:
 * 1. `DashboardSnapshot` holds the numbers already computed per scope
 *    (`area:<key>` and `control_tower`), refreshed every 5 minutes by the job
 *    `areas.dashboard_refresh`.
 * 2. Reading a panel takes that snapshot when it is fresh; when it is missing
 *    or stale it computes it right there and stores it, so the first person
 *    through the door pays once and everybody else reads the snapshot.
 * 3. The tiles marked `live` are recomputed on EVERY request with indexed
 *    `count()` queries, so "vencidos" is never a stale number.
 *
 * The snapshot is area-wide, never per person: it is computed with a system
 * actor and the access rule is applied when it is READ (`assertAreaAccess`,
 * the same rule as the work centre).
 */

// ---------------------------------------------------------------------------
// Scopes and storage
// ---------------------------------------------------------------------------

export const DASHBOARD_SCOPE_AREA = 'area';
export const DASHBOARD_SCOPE_CONTROL_TOWER = 'control_tower';

/** Actor used by the background refresh: it reads counters, never personal data. */
const SNAPSHOT_ACTOR: CurrentUser = {
  id: 'system.dashboard_refresh',
  username: 'system',
  name: 'Refresco de indicadores',
  email: null,
  mustChangePassword: false,
  roleKeys: [],
  permissionKeys: [],
  isSuperAdmin: true,
};

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'areas-dashboard', event, ...extra }));

const statToneSchema = z.enum(['default', 'success', 'warning', 'danger', 'info']);
const chartToneSchema = z.enum(['brand', 'info', 'success', 'warning', 'danger', 'muted']);

const tileSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string(),
  hint: z.string().nullish(),
  tone: statToneSchema.optional(),
  delta: z
    .object({
      value: z.union([z.string(), z.number()]),
      direction: z.enum(['up', 'down', 'flat']),
      intent: z.enum(['positive', 'negative', 'neutral']).optional(),
      label: z.string().optional(),
    })
    .optional(),
  href: z.string().optional(),
  live: z.boolean().optional(),
});

const chartSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('trend'),
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    xKey: z.string(),
    data: z.array(z.record(z.string(), z.union([z.string(), z.number()]))),
    series: z.array(z.object({ key: z.string(), label: z.string(), tone: chartToneSchema })),
    xLabel: z.string().optional(),
  }),
  z.object({
    kind: z.literal('bar'),
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    data: z.array(
      z.object({ label: z.string(), value: z.number(), tone: chartToneSchema.optional() })
    ),
    valueLabel: z.string().optional(),
    categoryLabel: z.string().optional(),
  }),
  z.object({
    kind: z.literal('status'),
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    segments: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        count: z.number(),
        tone: chartToneSchema,
      })
    ),
  }),
]);

const payloadSchema = z.object({
  areaKey: z.string(),
  tiles: z.array(tileSchema),
  charts: z.array(chartSchema),
  alerts: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(['info', 'warning', 'danger']),
      title: z.string(),
      detail: z.string().optional(),
      href: z.string().optional(),
      at: z.string().optional(),
    })
  ),
  computedAt: z.string(),
  source: z.enum(['live', 'snapshot']),
  note: z.string().nullish(),
});

/**
 * Stored JSON → payload. A snapshot written by an older shape of the panel is
 * discarded (null) instead of crashing the page: the caller recomputes it.
 */
export function parseDashboardPayload(value: unknown): AreaDashboardPayload | null {
  const parsed = payloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface DashboardSnapshotRecord {
  payload: unknown;
  computedAt: Date;
  durationMs: number;
}

/** Raw snapshot of any scope (`control_tower` reads its own with this). */
export async function readDashboardSnapshot(
  scopeType: string,
  scopeKey = ''
): Promise<DashboardSnapshotRecord | null> {
  const row = await prisma.dashboardSnapshot.findUnique({
    where: { scopeType_scopeKey: { scopeType, scopeKey } },
    select: { payload: true, computedAt: true, durationMs: true },
  });
  return row
    ? { payload: row.payload, computedAt: row.computedAt, durationMs: row.durationMs }
    : null;
}

/** Writes (or replaces) the snapshot of a scope. Never throws at the caller: it logs and returns false. */
export async function saveDashboardSnapshot(
  scopeType: string,
  scopeKey: string,
  payload: unknown,
  options: { computedAt?: Date; durationMs?: number } = {}
): Promise<boolean> {
  const computedAt = options.computedAt ?? new Date();
  const durationMs = Math.max(0, Math.round(options.durationMs ?? 0));
  const data = {
    payload: payload as Prisma.InputJsonValue,
    computedAt,
    durationMs,
  };
  try {
    await prisma.dashboardSnapshot.upsert({
      where: { scopeType_scopeKey: { scopeType, scopeKey } },
      update: data,
      create: { scopeType, scopeKey, ...data },
    });
    return true;
  } catch (err) {
    log('snapshot_write_failed', {
      scopeType,
      scopeKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Live tiles
// ---------------------------------------------------------------------------

export type AreaLiveTileProvider = (
  area: AreaMeta,
  options: { now: Date }
) => Promise<LiveTilePatch[]>;

type LiveRegistry = Map<string, AreaLiveTileProvider>;
type GlobalWithLive = typeof globalThis & { __unikAreaLiveTiles?: LiveRegistry };

function liveRegistry(): LiveRegistry {
  const scope = globalThis as GlobalWithLive;
  if (!scope.__unikAreaLiveTiles) scope.__unikAreaLiveTiles = new Map();
  return scope.__unikAreaLiveTiles;
}

/**
 * An area adds its own live tiles from `src/modules/areas/<area>/register.ts`.
 * They are merged ON TOP of the core ones (same id wins), and a tile marked
 * `live` with nobody to recompute it simply loses the mark.
 */
export function registerAreaLiveTiles(
  areaKey: AreaWorkspaceKey,
  provider: AreaLiveTileProvider
): void {
  liveRegistry().set(areaKey, provider);
}

const fmt = (value: number) => value.toLocaleString('es-MX');

/**
 * Live tiles every area has, with the ids the default panel uses: open work,
 * overdue work and requests received. Three indexed `count()` queries.
 */
export async function coreAreaLiveTiles(
  area: AreaMeta,
  options: { now: Date }
): Promise<LiveTilePatch[]> {
  const { now } = options;
  const openWork = { areaKey: area.key, status: { in: [...WORK_ITEM_OPEN_STATUSES] } };
  const openRequests = {
    toAreaKey: area.key,
    status: { in: [...AREA_REQUEST_OPEN_STATUSES] },
  };
  const [open, overdue, requestsIn, requestsInOverdue] = await Promise.all([
    prisma.workItem.count({ where: openWork }),
    prisma.workItem.count({ where: { ...openWork, dueAt: { lt: now } } }),
    prisma.areaRequest.count({ where: openRequests }),
    prisma.areaRequest.count({ where: { ...openRequests, dueAt: { lt: now } } }),
  ]);
  return [
    { id: 'open', value: fmt(open) },
    {
      id: 'overdue',
      value: fmt(overdue),
      tone: overdue > 0 ? 'danger' : 'success',
      hint: overdue > 0 ? 'Ya pasaron su fecha de compromiso' : 'Nada fuera de tiempo',
    },
    {
      id: 'requests_in',
      value: fmt(requestsIn),
      tone: requestsInOverdue > 0 ? 'danger' : 'default',
      hint:
        requestsInOverdue > 0
          ? `${fmt(requestsInOverdue)} sin atender a tiempo`
          : 'Todas dentro de plazo',
    },
  ];
}

/** Live tiles of an area (core + whatever it registered). Checks the area access rule. */
export async function getAreaLiveTiles(
  actor: CurrentUser,
  area: AreaMeta,
  options: { now?: Date } = {}
): Promise<LiveTilePatch[]> {
  await assertAreaAccess(actor, area);
  await ensureAreaRegistrations();
  const now = options.now ?? new Date();
  const core = await coreAreaLiveTiles(area, { now });
  const provider = liveRegistry().get(area.key);
  if (!provider) return core;
  const extra = await provider(area, { now });
  const byId = new Map(core.map((patch) => [patch.id, patch]));
  for (const patch of extra) byId.set(patch.id, patch);
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Reading a panel
// ---------------------------------------------------------------------------

/** Panel of an area, plus the live values already merged into it. */
export interface AreaDashboardView {
  /** null only when the numbers could not be computed ("Sin datos aún"). */
  payload: AreaDashboardPayload | null;
  /** Spanish note for the person when something did not load. */
  note: string | null;
  /** ISO instant the live tiles were computed (null when none could be). */
  liveAt: string | null;
}

/** Runs the area's own panel, or the default one of the core. */
export async function computeAreaDashboard(
  actor: CurrentUser,
  area: AreaMeta,
  options: { now?: Date } = {}
): Promise<AreaDashboardPayload> {
  const now = options.now ?? new Date();
  await ensureAreaRegistrations();
  const custom = getAreaServer(area.key).loadDashboard;
  return custom
    ? await custom(actor, area, { now })
    : await loadDefaultAreaDashboard(actor, area, { now });
}

export interface GetAreaDashboardOptions {
  now?: Date;
  /** Ignores the snapshot and recomputes ("Actualizar"). */
  refresh?: boolean;
  /** Maximum age of a usable snapshot (default: the refresh cadence). */
  ttlMs?: number;
}

/**
 * Panel of an area for a person: snapshot when it is fresh, freshly computed
 * (and stored) when it is not, always with the live tiles recomputed.
 */
export async function getAreaDashboard(
  actor: CurrentUser,
  area: AreaMeta,
  options: GetAreaDashboardOptions = {}
): Promise<AreaDashboardView> {
  await assertAreaAccess(actor, area);
  const now = options.now ?? new Date();
  let payload: AreaDashboardPayload | null = null;
  let note: string | null = null;

  if (!options.refresh) {
    try {
      const snapshot = await readDashboardSnapshot(DASHBOARD_SCOPE_AREA, area.key);
      if (snapshot && isSnapshotFresh(snapshot.computedAt, now, options.ttlMs)) {
        const stored = parseDashboardPayload(snapshot.payload);
        if (stored) {
          payload = {
            ...stored,
            source: 'snapshot',
            computedAt: snapshot.computedAt.toISOString(),
          };
        }
      }
    } catch (err) {
      log('snapshot_read_failed', {
        areaKey: area.key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!payload) {
    const startedAt = Date.now();
    try {
      payload = await computeAreaDashboard(actor, area, { now });
      await saveDashboardSnapshot(DASHBOARD_SCOPE_AREA, area.key, payload, {
        computedAt: new Date(payload.computedAt),
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      log('compute_failed', {
        areaKey: area.key,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        payload: null,
        note: `No pudimos calcular los indicadores de ${area.label}. Intenta actualizar en unos segundos.`,
        liveAt: null,
      };
    }
  }

  let liveAt: string | null = null;
  let live: LiveTilePatch[] = [];
  try {
    live = await getAreaLiveTiles(actor, area, { now });
    liveAt = now.toISOString();
  } catch (err) {
    note = 'Algunos indicadores en vivo no se pudieron actualizar; ves los del último cálculo.';
    log('live_tiles_failed', {
      areaKey: area.key,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const uncovered = uncoveredLiveTileIds(payload, live);
  if (uncovered.length > 0) {
    // Wiring defect: the panel promises "En vivo" for an id no provider emits,
    // so the tile silently falls back to the snapshot. Say it out loud.
    log('live_tiles_uncovered', { areaKey: area.key, tileIds: uncovered });
  }

  return { payload: applyLiveTiles(payload, live), note: note ?? payload.note ?? null, liveAt };
}

// ---------------------------------------------------------------------------
// Refresh (job)
// ---------------------------------------------------------------------------

export interface DashboardSnapshotProvider {
  scopeType: string;
  scopeKey: string;
  compute: (options: { now: Date }) => Promise<unknown>;
}

type ProviderRegistry = Map<string, DashboardSnapshotProvider>;
type GlobalWithProviders = typeof globalThis & { __unikDashboardProviders?: ProviderRegistry };

function providerRegistry(): ProviderRegistry {
  const scope = globalThis as GlobalWithProviders;
  if (!scope.__unikDashboardProviders) scope.__unikDashboardProviders = new Map();
  return scope.__unikDashboardProviders;
}

/**
 * Scopes outside the six areas that ride the same job and the same table
 * (Control Tower registers `control_tower` here with its own payload).
 */
export function registerDashboardSnapshotProvider(provider: DashboardSnapshotProvider): void {
  providerRegistry().set(`${provider.scopeType}:${provider.scopeKey}`, provider);
}

export interface DashboardRefreshSummary {
  refreshed: Array<{ scope: string; durationMs: number }>;
  failed: Array<{ scope: string; error: string }>;
  durationMs: number;
}

export interface RefreshDashboardOptions {
  /** Only these areas (default: the six). */
  areaKeys?: readonly string[];
  now?: Date;
  /** Stops between scopes when the job is aborted. */
  signal?: AbortSignal;
  /** Skips the registered non-area scopes (Control Tower). */
  areasOnly?: boolean;
}

/**
 * Recomputes and stores the snapshots. One scope failing never stops the rest:
 * each failure is reported so the job result says exactly what did not refresh.
 */
export async function refreshDashboardSnapshots(
  options: RefreshDashboardOptions = {}
): Promise<DashboardRefreshSummary> {
  const now = options.now ?? new Date();
  const startedAt = Date.now();
  const summary: DashboardRefreshSummary = { refreshed: [], failed: [], durationMs: 0 };
  await ensureAreaRegistrations();

  const requested = options.areaKeys ? new Set(options.areaKeys) : null;
  const areas = AREA_LIST.filter((area) => !requested || requested.has(area.key));

  for (const area of areas) {
    if (options.signal?.aborted) break;
    const scope = `${DASHBOARD_SCOPE_AREA}:${area.key}`;
    const areaStartedAt = Date.now();
    try {
      const payload = await computeAreaDashboard(SNAPSHOT_ACTOR, area, { now });
      const durationMs = Date.now() - areaStartedAt;
      await saveDashboardSnapshot(DASHBOARD_SCOPE_AREA, area.key, payload, {
        computedAt: new Date(payload.computedAt),
        durationMs,
      });
      summary.refreshed.push({ scope, durationMs });
    } catch (err) {
      summary.failed.push({ scope, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!options.areasOnly && !requested) {
    for (const provider of providerRegistry().values()) {
      if (options.signal?.aborted) break;
      const scope = `${provider.scopeType}:${provider.scopeKey}`;
      const providerStartedAt = Date.now();
      try {
        const payload = await provider.compute({ now });
        const durationMs = Date.now() - providerStartedAt;
        await saveDashboardSnapshot(provider.scopeType, provider.scopeKey, payload, {
          computedAt: now,
          durationMs,
        });
        summary.refreshed.push({ scope, durationMs });
      } catch (err) {
        summary.failed.push({ scope, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  summary.durationMs = Date.now() - startedAt;
  log('snapshots_refreshed', {
    refreshed: summary.refreshed.length,
    failed: summary.failed.length,
    durationMs: summary.durationMs,
  });
  return summary;
}

export { DASHBOARD_SNAPSHOT_TTL_MS };
