import 'server-only';

import type { CurrentUser } from '@/modules/auth/authorization';
import type {
  AlertSeverity,
  StatDelta,
  StatTone,
  StatusSegment,
} from '@/components/patterns/dashboard/dashboard-utils';
import type { ChartTone } from '@/components/patterns/dashboard/chart-theme';
import type { AreaMeta, AreaWorkspaceKey } from './area-registry';
import { AREA_WORKSPACE_KEYS } from './area-registry';
import type { AreaRowDetail, AreaWorkRow } from './area-work-row';
import { commonWorkRowBranches, type WorkRowBranch } from './work-rows-sql';

/**
 * Server registry of the areas (plan 7.2). SERVER ONLY: it holds the functions
 * that read the database for one area — its dashboard, its own work-row
 * branches and the detail of those rows.
 *
 * Each domain area registers itself from `src/modules/areas/<area>/register.ts`
 * (loaded by `register-all.ts`). An area that has not registered anything still
 * works: the common branches (its work items and the requests it received and
 * sent) and the default dashboard answer with real data, so every area is
 * usable from the first minute.
 *
 * THIS FILE OWNS THE CONTRACT TYPES. Domain agents import them from here and
 * never redefine them, so the dashboard space, the work centre and the drawer
 * read the same shapes.
 */

// ---------------------------------------------------------------------------
// Dashboard payload
// ---------------------------------------------------------------------------

export interface AreaDashboardTile {
  id: string;
  label: string;
  /** Already formatted for a person ("12", "$1,204.00", "83 %"). */
  value: string;
  hint?: string | null;
  tone?: StatTone;
  delta?: StatDelta;
  /** Filtered list behind the KPI (usually a link to the work centre). */
  href?: string;
  /** Computed on every request instead of read from the snapshot. */
  live?: boolean;
}

export interface AreaTrendChart {
  kind: 'trend';
  id: string;
  title: string;
  description?: string;
  /** Key of the X axis inside every datum (e.g. `day`). */
  xKey: string;
  data: Array<Record<string, string | number>>;
  series: Array<{ key: string; label: string; tone: ChartTone }>;
  /** Accessible name of the X column. */
  xLabel?: string;
  /**
   * The series counts things, so the Y axis shows whole numbers (default).
   * Set it to false for a money or percentage series.
   */
  integerY?: boolean;
}

export interface AreaBarChart {
  kind: 'bar';
  id: string;
  title: string;
  description?: string;
  data: Array<{ label: string; value: number; tone?: ChartTone }>;
  valueLabel?: string;
  categoryLabel?: string;
}

export interface AreaStatusChart {
  kind: 'status';
  id: string;
  title: string;
  description?: string;
  segments: StatusSegment[];
}

export type AreaDashboardChart = AreaTrendChart | AreaBarChart | AreaStatusChart;

export interface AreaDashboardAlert {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail?: string;
  href?: string;
  /** ISO instant of the fact behind the alert. */
  at?: string;
}

export interface AreaDashboardPayload {
  areaKey: string;
  /** At most 8 tiles (plan 7.3). */
  tiles: AreaDashboardTile[];
  /** At most 2 charts. */
  charts: AreaDashboardChart[];
  alerts: AreaDashboardAlert[];
  /** ISO instant the numbers were computed at ("Actualizado hace 3 min"). */
  computedAt: string;
  /** `live` = computed for this request; `snapshot` = read from DashboardSnapshot. */
  source: 'live' | 'snapshot';
  /** Spanish note when part of the panel could not be computed. */
  note?: string | null;
}

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

export interface AreaServerOptions {
  now: Date;
}

export interface AreaServerModule {
  /**
   * Extra branches of the UNION (`work-rows-sql.ts` builds them with
   * `areaWorkRowSelect`, which keeps the canonical column list).
   */
  workRowBranches?: WorkRowBranch[];
  /** Panel of the area. Without it the default dashboard answers. */
  loadDashboard?: (
    actor: CurrentUser,
    area: AreaMeta,
    options: AreaServerOptions
  ) => Promise<AreaDashboardPayload>;
  /**
   * Detail of one of the area's own rows (the core resolves work items and
   * requests on its own). Returns only the parts it knows; the service fills
   * the rest (timeline, case summary, evidence).
   */
  getRowDetail?: (
    actor: CurrentUser,
    row: AreaWorkRow,
    options: AreaServerOptions
  ) => Promise<Partial<AreaRowDetail> | null>;
}

type RegistryMap = Map<string, AreaServerModule>;

type GlobalWithRegistry = typeof globalThis & {
  __unikAreaServerRegistry?: RegistryMap;
};

function registry(): RegistryMap {
  const scope = globalThis as GlobalWithRegistry;
  if (!scope.__unikAreaServerRegistry) scope.__unikAreaServerRegistry = new Map();
  return scope.__unikAreaServerRegistry;
}

/**
 * Registers the server side of an area. Called once from
 * `src/modules/areas/<area>/register.ts`; registering again replaces the entry
 * (hot reload in development).
 */
export function registerAreaServer(areaKey: AreaWorkspaceKey, module: AreaServerModule): void {
  registry().set(areaKey, module);
}

/** What the area registered, or an empty module (the defaults still work). */
export function getAreaServer(areaKey: string): AreaServerModule {
  return registry().get(areaKey) ?? {};
}

export function isAreaServerRegistered(areaKey: string): boolean {
  return registry().has(areaKey);
}

/** Areas that already registered their server side (diagnostics and tests). */
export function registeredAreaKeys(): AreaWorkspaceKey[] {
  return AREA_WORKSPACE_KEYS.filter((key) => registry().has(key));
}

/**
 * Branches of an area: the common ones first (work items and requests) plus the
 * ones it registered. A registered branch with a common row kind replaces the
 * common one, so an area can enrich its own work items if it ever needs to.
 */
export function areaWorkBranches(area: AreaMeta): WorkRowBranch[] {
  const declared = new Set(area.workCenter.rowKinds);
  const branches = new Map<string, WorkRowBranch>();
  for (const branch of commonWorkRowBranches()) branches.set(branch.rowKind, branch);
  for (const branch of getAreaServer(area.key).workRowBranches ?? []) {
    // A branch for a row kind the area does not declare would never be shown nor filtered.
    if (!declared.has(branch.rowKind)) continue;
    branches.set(branch.rowKind, branch);
  }
  return [...branches.values()];
}

/** Row kinds with a branch behind them right now (the chips only offer these). */
export function availableRowKinds(area: AreaMeta): string[] {
  const withBranch = new Set(areaWorkBranches(area).map((branch) => branch.rowKind));
  return area.workCenter.rowKinds.filter((kind) => withBranch.has(kind));
}

/** Testing helper: forgets every registration (never used by the app). */
export function resetAreaServerRegistry(): void {
  registry().clear();
}
