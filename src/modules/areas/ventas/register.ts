import { registerAreaServer } from '@/modules/areas/area-server-registry';
import { registerAreaLiveTiles } from '@/modules/areas/dashboard-service';
import { getVentasRowDetail } from './row-detail';
import { loadVentasDashboard, ventasLiveTiles } from './ventas-dashboard';
import { ventasWorkRowBranches } from './work-branches';

/**
 * Registro de servidor del área Ventas (plan 7.2). Se importa desde
 * `src/modules/areas/register-all.ts` y su único efecto es registrar el módulo:
 * ramas de filas (expedientes, oportunidades y cotizaciones), panel comercial y
 * detalle de esas filas. Las solicitudes y los work items los sigue aportando
 * el núcleo.
 */
registerAreaServer('ventas', {
  workRowBranches: ventasWorkRowBranches(),
  loadDashboard: loadVentasDashboard,
  getRowDetail: (actor, row) => getVentasRowDetail(actor, row),
});

// Expedientes abiertos · Bloqueados · Señales del radar: sin este registro
// perderían su marca «En vivo» y se servirían desde la proyección.
registerAreaLiveTiles('ventas', ventasLiveTiles);
