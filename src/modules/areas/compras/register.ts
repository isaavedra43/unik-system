import { registerAreaServer } from '../area-server-registry';
import { registerAreaLiveTiles } from '../dashboard-service';
import { comprasLiveTiles, loadComprasDashboard } from './compras-dashboard';
import { getComprasRowDetail } from './compras-detail';
import { comprasWorkRowBranches } from './compras-rows';

/**
 * Server side of the Compras area (plan 7.3, 7.4 and 7.6).
 *
 * Imported by `src/modules/areas/register-all.ts`; registering is its only job,
 * so importing it twice (hot reload) simply replaces the entry.
 *
 * Requests of the area are NOT registered here: the core already answers them
 * with `listAreaRequests` through `GET /app/areas/compras/api/requests`, and
 * the work centre lists them as the common `request_in` / `request_out` rows.
 */
registerAreaServer('compras', {
  workRowBranches: comprasWorkRowBranches(),
  loadDashboard: loadComprasDashboard,
  getRowDetail: getComprasRowDetail,
});

// Tiles recomputed on every request; without this they would fall back to the
// snapshot value and lose their "En vivo" mark.
registerAreaLiveTiles('compras', comprasLiveTiles);
