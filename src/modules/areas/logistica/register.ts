import { registerAreaServer } from '../area-server-registry';
import { registerAreaLiveTiles } from '../dashboard-service';
import { loadLogisticsDashboard, logisticsLiveTiles } from './dashboard';
import { getLogisticsRowDetail } from './queries';
import { logisticsWorkRowBranches } from './work-rows';

/**
 * Server side of the Logística area (plan 7.2). Importing this file registers
 * it; `src/modules/areas/register-all.ts` does that once per process before any
 * page, action or API route of `/app/areas` reads the registry.
 *
 * - `workRowBranches`: delivery orders and trips, added to the common branches.
 * - `loadDashboard`: the tiles, charts and alerts of plan 7.3 with real data.
 * - `getRowDetail`: what the drawer and the detail page show for those rows.
 *
 * The special view (Despacho), the trip page, the fleet page and the driver PWA
 * live in `src/components/areas/logistica/` and under `/app/areas/logistica/…`.
 */

registerAreaServer('logistica', {
  workRowBranches: logisticsWorkRowBranches(),
  loadDashboard: (actor, area, options) => loadLogisticsDashboard(actor, area, options),
  getRowDetail: (actor, row) => getLogisticsRowDetail(actor, row),
});

// Entregas hoy · En ruta · Sin asignar: sin este registro perderían su marca
// "En vivo" y se servirían desde la proyección (hasta 5 minutos de retraso).
registerAreaLiveTiles('logistica', logisticsLiveTiles);
