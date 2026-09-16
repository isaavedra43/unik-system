'use client';

import { isAreaClientRegistered } from './area-client-registry';

/**
 * Loads the client side of an area on demand (plan 7.2).
 *
 * `src/components/areas/<area>/register-client.tsx` registers itself when it is
 * imported. This barrel imports the one being shown and nothing else, so an
 * area's cell renderers and specialized view never reach another area's bundle.
 *
 * The imports are LITERAL for the same reason as the server barrel: a template
 * path builds a folder context that Vite cannot resolve, which turned a missing
 * registration into a silently empty specialized view instead of a build error.
 */

/** One literal import per area; the key is the area key of the registry. */
const AREA_CLIENT_MODULES: Record<string, () => Promise<unknown>> = {
  ventas: () => import('./ventas/register-client'),
  compras: () => import('./compras/register-client'),
  inventario: () => import('./inventario/register-client'),
  manufactura: () => import('./manufactura/register-client'),
  logistica: () => import('./logistica/register-client'),
  contabilidad: () => import('./contabilidad/register-client'),
};

const pending = new Map<string, Promise<boolean>>();

export function ensureAreaClientRegistrations(areaKey: string): Promise<boolean> {
  if (isAreaClientRegistered(areaKey)) return Promise.resolve(true);
  const cached = pending.get(areaKey);
  if (cached) return cached;
  const load = AREA_CLIENT_MODULES[areaKey];
  if (!load) return Promise.resolve(false);
  const promise = load()
    .then(() => true)
    .catch((err: unknown) => {
      console.error(
        JSON.stringify({
          component: 'areas-client-registry',
          event: 'area_client_module_failed',
          area: areaKey,
          error: err instanceof Error ? err.message : String(err),
        })
      );
      return false;
    });
  pending.set(areaKey, promise);
  return promise;
}

/** Testing helper: the next call imports the module again. */
export function resetAreaClientRegistrations(): void {
  pending.clear();
}
