import { notFound } from 'next/navigation';
import { AreaWorkspaceShell } from '@/components/areas/AreaWorkspaceShell';
import { PipelineBoard } from '@/components/areas/ventas/PipelineBoard';
import { hasPermission, requireAnyPermission } from '@/modules/auth/authorization';
import { areaViewPermissions, getArea } from '@/modules/areas/area-registry';
import { ensureAreaRegistrations } from '@/modules/areas/register-all';
import { getVentasPipeline, listConvertibleQuotes } from '@/modules/areas/ventas/ventas-queries';
import { VENTAS_AREA_KEY } from '@/modules/areas/ventas/ventas-constants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Embudo comercial de Ventas (`/app/areas/ventas/pipeline`): tablero por etapa
 * con arrastrar para cambiar de etapa y su alternativa por menú, más las
 * cotizaciones aceptadas que faltan por convertir en orden de venta.
 *
 * Es una página del área: el gate del layout ya exigió el permiso de vista de
 * Ventas; ver el embudo necesita además `crm.view`, y moverlo `crm.manage`
 * (ambos los revalidan los servicios y el motor).
 */
export default async function VentasPipelinePage({
  params,
}: {
  params: Promise<{ areaKey: string }>;
}) {
  const { areaKey } = await params;
  const area = getArea(areaKey);
  if (!area || area.key !== VENTAS_AREA_KEY) notFound();

  const user = await requireAnyPermission(areaViewPermissions(area));
  await ensureAreaRegistrations();

  if (!hasPermission(user, 'crm.view')) {
    return (
      <AreaWorkspaceShell area={area} user={user} activeSlug="pipeline">
        <div className="area-space">
          <div className="area-empty">
            <strong>Embudo comercial</strong>
            <p>
              Para ver el embudo por etapa necesitas el permiso «Ver CRM». El panel, el centro de
              trabajo y las comunicaciones de Ventas siguen disponibles.
            </p>
          </div>
        </div>
      </AreaWorkspaceShell>
    );
  }

  const nowIso = new Date().toISOString();
  const [pipeline, convertible] = await Promise.all([
    getVentasPipeline(user),
    listConvertibleQuotes(user),
  ]);

  return (
    <AreaWorkspaceShell area={area} user={user} activeSlug="pipeline">
      <div className="area-space">
        <p className="area-space-description">
          Oportunidades por etapa. Arrastra una tarjeta para moverla de etapa o usa «Mover a…» desde
          su menú; ganar y perder piden confirmación o motivo.
        </p>
        <PipelineBoard
          userId={user.id}
          board={pipeline.board}
          stages={pipeline.stages}
          allStages={pipeline.allStages}
          canManage={pipeline.permissions.canManage}
          canManageStages={pipeline.permissions.canManageStages}
          canCreateSalesOrder={pipeline.permissions.canCreateSalesOrder}
          convertible={convertible}
          nowIso={nowIso}
        />
      </div>
    </AreaWorkspaceShell>
  );
}
