import { registerAreaServer } from '@/modules/areas/area-server-registry';
import { registerAreaLiveTiles } from '@/modules/areas/dashboard-service';
import { loadManufacturaDashboard, loadManufacturaLiveTiles } from './dashboard';
import { getManufacturaRowDetail } from './row-detail';
import { manufacturaWorkRowBranches } from './work-rows';

/**
 * Server side of the Manufactura area (plan 7.2). Importing this file registers
 * it; `src/modules/areas/register-all.ts` does that once per process before any
 * area page, action or API route reads the registry.
 *
 * - `workRowBranches`: production orders and floor operations as work rows.
 * - `loadDashboard`: the tiles, charts and alerts of Manufactura (plan 7.3).
 * - `getRowDetail`: the facts of an order or an operation for the drawer and the
 *   detail page.
 * - `registerAreaLiveTiles`: the three tiles the panel recomputes on every
 *   request, so they keep their "En vivo" mark instead of losing it to the
 *   5-minute snapshot.
 *
 * The requests Manufactura sends and receives need nothing here: the core
 * answers them for every area (`listAreaRequests`, common branches).
 */
registerAreaServer('manufactura', {
  workRowBranches: manufacturaWorkRowBranches(),
  loadDashboard: (actor, area, options) => loadManufacturaDashboard(actor, area, options),
  getRowDetail: (actor, row) => getManufacturaRowDetail(actor, row),
});

registerAreaLiveTiles('manufactura', loadManufacturaLiveTiles);
