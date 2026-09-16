import { registerAreaServer } from '@/modules/areas/area-server-registry';
import { registerAreaLiveTiles } from '@/modules/areas/dashboard-service';
import { CONTABILIDAD_AREA_KEY } from './contabilidad-model';
import { contabilidadLiveTiles, loadContabilidadDashboard } from './dashboard';
import { getContabilidadRowDetail } from './row-detail';
import { contabilidadWorkRowBranches } from './work-rows';

/**
 * Server side of Contabilidad (plan 7.2). Importing this file registers the
 * area; `src/modules/areas/register-all.ts` does it once per process before any
 * page, action or API route of `/app/areas` reads the registry.
 *
 * - `workRowBranches`: gastos, obligaciones y tareas de cierre, sobre las ramas
 *   comunes del núcleo.
 * - `loadDashboard`: los tiles, las gráficas y las alertas del plan 7.3.
 * - `getRowDetail`: lo que muestran el cajón y la página de detalle.
 * - Live tiles: las tres cifras que no pueden estar viejas (vencidas, gastos
 *   sin comprobante y solicitudes entrantes).
 *
 * La vista especial (Libro de caja) y las páginas de gestión viven en
 * `src/components/areas/contabilidad/` y bajo `/app/areas/contabilidad/…`.
 */

registerAreaServer(CONTABILIDAD_AREA_KEY, {
  workRowBranches: contabilidadWorkRowBranches(),
  loadDashboard: (actor, area, options) => loadContabilidadDashboard(actor, area, options),
  getRowDetail: (actor, row, options) => getContabilidadRowDetail(actor, row, options),
});

registerAreaLiveTiles(CONTABILIDAD_AREA_KEY, (area, options) =>
  contabilidadLiveTiles(area, options)
);
