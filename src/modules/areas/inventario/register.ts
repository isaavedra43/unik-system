import { registerAreaServer } from '@/modules/areas/area-server-registry';
import { registerAreaLiveTiles } from '@/modules/areas/dashboard-service';
import { inventoryLiveTiles, loadInventoryDashboard } from './dashboard';
import { getInventoryRowDetail } from './row-detail';
import { inventoryWorkRowBranches } from './work-rows';

/**
 * Server side of the Inventario area (plan 7.2): its work-row branches, its
 * panel and the detail of its own rows. Loaded once by
 * `@/modules/areas/register-all`; importing this file registers the area.
 */
registerAreaServer('inventario', {
  workRowBranches: inventoryWorkRowBranches(),
  loadDashboard: loadInventoryDashboard,
  getRowDetail: getInventoryRowDetail,
});

// Verificaciones · Conteos en curso · SKUs en disputa: sin este registro
// perderían su marca "En vivo" y se servirían desde la proyección.
registerAreaLiveTiles('inventario', inventoryLiveTiles);

export {};
