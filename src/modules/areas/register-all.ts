import { AREA_WORKSPACE_KEYS, type AreaWorkspaceKey } from './area-registry';

/**
 * Barrel that loads the server side of every area (plan 7.2).
 *
 * Each domain area ships `src/modules/areas/<area>/register.ts`, whose only job
 * is to call `registerAreaServer('<area>', { ... })` when it is imported.
 *
 * The imports are LITERAL on purpose. A template path (`./${key}/register`)
 * makes the bundler build a context of the whole folder — it resolves under
 * Webpack/Turbopack but not under Vite, so the registrations silently vanished
 * in vitest and were unverifiable until a build ran. With one entry per area
 * the resolution is static, the failure mode is a compile error instead of an
 * empty work centre, and adding an area is one line here.
 *
 * `ensureAreaRegistrations()` is idempotent and memoized per process: every
 * page, action and API route of `/app/areas` awaits it before reading the
 * registry. It never throws — an area whose module fails to load keeps working
 * with the common branches and the default dashboard.
 */

type Loaded = { key: AreaWorkspaceKey; registered: boolean; error: string | null };

/** One literal import per area. Adding an area to the registry without adding it here fails the type check. */
const AREA_MODULES: Record<AreaWorkspaceKey, () => Promise<unknown>> = {
  ventas: () => import('./ventas/register'),
  compras: () => import('./compras/register'),
  inventario: () => import('./inventario/register'),
  manufactura: () => import('./manufactura/register'),
  logistica: () => import('./logistica/register'),
  contabilidad: () => import('./contabilidad/register'),
};

let pending: Promise<Loaded[]> | null = null;

async function loadArea(key: AreaWorkspaceKey): Promise<Loaded> {
  try {
    await AREA_MODULES[key]();
    return { key, registered: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { key, registered: false, error: message };
  }
}

/** Loads every area module once. Never throws: a module that fails to load is logged, not fatal. */
export function ensureAreaRegistrations(): Promise<Loaded[]> {
  if (!pending) {
    pending = Promise.all(AREA_WORKSPACE_KEYS.map(loadArea)).then((results) => {
      const failed = results.filter((result) => !result.registered);
      if (failed.length > 0) {
        console.error(
          JSON.stringify({
            component: 'areas-registry',
            event: 'area_module_failed',
            areas: failed.map((result) => ({ area: result.key, error: result.error })),
          })
        );
      }
      return results;
    });
  }
  return pending;
}

/** Testing helper: the next call loads the modules again. */
export function resetAreaRegistrations(): void {
  pending = null;
}
