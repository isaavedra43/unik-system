import type { AreaDashboardPayload, AreaDashboardTile } from './area-server-registry';
import { relativeSince } from './area-time';

/**
 * Pure rules of the area panel cache (plan 7.3). ISOMORPHIC: the service uses
 * it to decide whether the snapshot is still good, and the client uses it to
 * label the freshness and to merge the live tiles it polls.
 *
 * Only TYPE imports from `area-server-registry` (that module reaches Prisma
 * through the SQL branches), so this file is safe in the browser bundle.
 */

/** The refresh job runs every 5 minutes; an older snapshot is recomputed on read. */
export const DASHBOARD_SNAPSHOT_TTL_MS = 5 * 60_000;

/** Tiles marked `live` are re-read once a minute while the tab is visible. */
export const DASHBOARD_LIVE_POLL_MS = 60_000;

/**
 * New value of a tile computed for this request. It never carries the label or
 * the link: those belong to the panel that produced the snapshot.
 */
export type LiveTilePatch = Pick<AreaDashboardTile, 'id' | 'value'> &
  Partial<Pick<AreaDashboardTile, 'tone' | 'hint'>>;

/** True while a snapshot computed at `computedAt` may still be shown. */
export function isSnapshotFresh(
  computedAt: string | Date | null | undefined,
  now: Date | number,
  ttlMs: number = DASHBOARD_SNAPSHOT_TTL_MS
): boolean {
  if (computedAt === null || computedAt === undefined) return false;
  const at = computedAt instanceof Date ? computedAt.getTime() : Date.parse(computedAt);
  if (!Number.isFinite(at)) return false;
  const reference = typeof now === 'number' ? now : now.getTime();
  // A snapshot from the future (clock skew) counts as fresh, never as expired.
  return reference - at < ttlMs;
}

/** "Actualizado hace 3 min" — the panel always states how old its numbers are. */
export function freshnessLabel(
  computedAt: string | Date | null | undefined,
  now: Date | number
): string {
  const label = relativeSince(computedAt, now);
  return label === 'sin fecha' ? 'Sin fecha de actualización' : `Actualizado ${label}`;
}

/** Where the numbers come from, in Spanish (empty for a panel computed now). */
export function sourceLabel(source: AreaDashboardPayload['source']): string | null {
  return source === 'snapshot' ? 'desde la última proyección' : null;
}

/** Ids of the tiles that must be recomputed on every request. */
export function liveTileIds(payload: AreaDashboardPayload | null): string[] {
  if (!payload) return [];
  return payload.tiles.filter((tile) => tile.live).map((tile) => tile.id);
}

/**
 * Ids of the tiles the panel declares `live` that NOBODY recomputed: they lose
 * the mark and are served from the snapshot. It is a wiring defect (an area
 * that marks a tile `live` without registering a provider for that id), so the
 * server logs it instead of letting it pass unnoticed.
 */
export function uncoveredLiveTileIds(
  payload: AreaDashboardPayload | null,
  patches: readonly LiveTilePatch[]
): string[] {
  if (!payload) return [];
  const covered = new Set(patches.map((patch) => patch.id));
  return payload.tiles.filter((tile) => tile.live && !covered.has(tile.id)).map((tile) => tile.id);
}

/**
 * Replaces the value of every `live` tile with the one just computed. A tile
 * nobody could recompute LOSES its live mark instead of claiming, with a stale
 * number, that it is up to the second.
 */
export function applyLiveTiles(
  payload: AreaDashboardPayload,
  patches: readonly LiveTilePatch[]
): AreaDashboardPayload {
  if (payload.tiles.length === 0) return payload;
  const byId = new Map(patches.map((patch) => [patch.id, patch]));
  return {
    ...payload,
    tiles: payload.tiles.map((tile) => {
      if (!tile.live) return tile;
      const patch = byId.get(tile.id);
      if (!patch) return { ...tile, live: false };
      return {
        ...tile,
        value: patch.value,
        ...(patch.tone === undefined ? {} : { tone: patch.tone }),
        ...(patch.hint === undefined ? {} : { hint: patch.hint }),
        live: true,
      };
    }),
  };
}

/** True when the panel has nothing to show yet ("Sin datos aún"). */
export function isDashboardEmpty(payload: AreaDashboardPayload | null): boolean {
  if (!payload) return true;
  return payload.tiles.length === 0 && payload.charts.length === 0 && payload.alerts.length === 0;
}
