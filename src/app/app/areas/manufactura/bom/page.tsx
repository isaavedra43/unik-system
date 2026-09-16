import { PageHeader, TabNav } from '@/components/ui/composite';
import { BomManager } from '@/components/areas/manufactura/BomManager';
import { hasPermission, requirePermission } from '@/modules/auth/authorization';
import { manufacturaSectionTabs } from '@/modules/areas/manufactura/manufactura-sections';
import { listBoms, listWorkCenters } from '@/modules/manufacturing/manufacturing-queries';
import '@/styles/operations/manufactura.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Listas de materiales versionadas. Ver pide `manufacturing.view`; crear,
 * editar, activar y retirar piden `manufacturing.manage_boms`.
 */
export default async function BomsPage() {
  const user = await requirePermission('manufacturing.view');
  const [boms, centers] = await Promise.all([
    listBoms(user, { pageSize: 100 }),
    listWorkCenters(user, { status: 'active' }),
  ]);
  // Esta página vive fuera de `/app/areas`, así que no hereda las pestañas del
  // área: sin la tira sería un callejón sin salida (y sin salida desde el área).
  const tabs = manufacturaSectionTabs(user);

  return (
    <div className="mfg-order">
      <PageHeader
        title="Listas de materiales"
        description="Recetas versionadas para productos repetibles: insumos, sustitutos permitidos y ruta por centro de trabajo."
      />
      {tabs.length > 1 ? <TabNav activeId="bom" tabs={tabs} /> : null}
      <BomManager
        boms={boms.rows}
        centers={centers.map((center) => ({ id: center.id, name: center.name }))}
        canManage={hasPermission(user, 'manufacturing.manage_boms')}
      />
    </div>
  );
}
