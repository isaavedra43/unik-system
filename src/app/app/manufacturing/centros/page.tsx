import { prisma } from '@/lib/prisma';
import { PageHeader, TabNav } from '@/components/ui/composite';
import { WorkCentersManager } from '@/components/areas/manufactura/WorkCentersManager';
import {
  WorkCenterLoadPanel,
  type WorkCenterLoadEntry,
} from '@/components/areas/manufactura/WorkCenterLoadPanel';
import { hasPermission, requirePermission } from '@/modules/auth/authorization';
import { manufacturaSectionTabs } from '@/modules/areas/manufactura/manufactura-sections';
import { getWorkCenterLoad, listWorkCenters } from '@/modules/manufacturing/manufacturing-queries';
import '@/styles/operations/manufactura.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ventana de carga que se muestra debajo de la capacidad, y tope de centros leídos. */
const LOAD_DAYS = 7;
const MAX_LOADED_CENTERS = 12;

/**
 * Centros de trabajo y turnos: la capacidad contra la que se programa la
 * producción, y la carga que ya tiene encima. Ver la lista pide
 * `manufacturing.view`; crearlos o editarlos pide `manufacturing.manage_boms`
 * (el comando lo valida de nuevo).
 *
 * La carga la lee `getWorkCenterLoad`, la misma consulta del módulo que usan el
 * planificador y el job de avisos de capacidad: no se recalcula aquí.
 */
export default async function WorkCentersPage() {
  const user = await requirePermission('manufacturing.view');
  const [centers, warehouses] = await Promise.all([
    listWorkCenters(user, {}),
    prisma.warehouse.findMany({
      where: { active: true },
      orderBy: [{ name: 'asc' }],
      select: { id: true, name: true },
    }),
  ]);

  const active = centers
    .filter((center) => center.status === 'active')
    .slice(0, MAX_LOADED_CENTERS);
  const loads: WorkCenterLoadEntry[] = await Promise.all(
    active.map(async (center) => {
      const load = await getWorkCenterLoad(user, { workCenterId: center.id, days: LOAD_DAYS });
      return {
        workCenter: {
          id: load.workCenter.id,
          name: load.workCenter.name,
          capacityUnitLabel: load.workCenter.capacityUnitLabel,
        },
        windows: load.windows,
        summary: {
          windows: load.summary.windows,
          overloadedWindows: load.summary.overloadedWindows,
          peakUtilizationPct: load.summary.peakUtilizationPct,
        },
        operations: load.operations,
      };
    })
  );

  // Misma razón que en Listas de materiales: fuera de `/app/areas` no hay
  // pestañas del área, así que la tira es la única salida de la página.
  const tabs = manufacturaSectionTabs(user);

  return (
    <div className="mfg-order">
      <PageHeader
        title="Centros de trabajo"
        description="Dónde se produce, cuánta capacidad hay por turno y en qué horario: es lo que usa el tablero para mostrar la carga."
      />
      {tabs.length > 1 ? <TabNav activeId="centros" tabs={tabs} /> : null}
      <WorkCentersManager
        centers={centers}
        warehouses={warehouses}
        canManage={hasPermission(user, 'manufacturing.manage_boms')}
      />

      <WorkCenterLoadPanel entries={loads} days={LOAD_DAYS} />
    </div>
  );
}
