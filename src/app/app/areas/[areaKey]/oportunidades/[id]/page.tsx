import { notFound } from 'next/navigation';
import { AreaWorkspaceShell } from '@/components/areas/AreaWorkspaceShell';
import { OpportunityDetailClient } from '@/components/areas/ventas/OpportunityDetailClient';
import { hasPermission, requireAnyPermission } from '@/modules/auth/authorization';
import { areaViewPermissions, getArea } from '@/modules/areas/area-registry';
import { ensureAreaRegistrations } from '@/modules/areas/register-all';
import { isCrmError } from '@/modules/crm/crm-helpers';
import { getOpportunityDetail, type OpportunityDetail } from '@/modules/crm/crm-queries';
import { listPipelineStages } from '@/modules/crm/pipeline-service';
import { VENTAS_AREA_KEY } from '@/modules/areas/ventas/ventas-constants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Detalle de una oportunidad (`/app/areas/ventas/oportunidades/[id]`, por id o
 * folio `OPP-000123`): datos, línea de tiempo, cotizaciones, órdenes,
 * expedientes, conversaciones y señales, con las acciones de etapa, siguiente
 * acción y registro de actividad.
 *
 * Las cotizaciones, órdenes y expedientes sólo se describen a quien puede
 * verlos en su módulo: esa regla la aplica `getOpportunityDetail`.
 */
export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ areaKey: string; id: string }>;
}) {
  const { areaKey, id } = await params;
  const area = getArea(areaKey);
  if (!area || area.key !== VENTAS_AREA_KEY) notFound();

  const user = await requireAnyPermission(areaViewPermissions(area));
  await ensureAreaRegistrations();

  if (!hasPermission(user, 'crm.view')) {
    return (
      <AreaWorkspaceShell area={area} user={user} activeSlug="oportunidades">
        <div className="area-space">
          <div className="area-empty">
            <strong>Oportunidad</strong>
            <p>
              Para abrir una oportunidad necesitas el permiso «Ver CRM». El panel y el centro de
              trabajo de Ventas siguen disponibles.
            </p>
          </div>
        </div>
      </AreaWorkspaceShell>
    );
  }

  let detail: OpportunityDetail;
  try {
    detail = await getOpportunityDetail(user, decodeURIComponent(id));
  } catch (error) {
    if (isCrmError(error) && (error.status === 404 || error.status === 403)) notFound();
    throw error;
  }
  const stages = await listPipelineStages(user);

  return (
    <AreaWorkspaceShell area={area} user={user} activeSlug="oportunidades">
      <div className="area-space">
        <div className="area-shell-heading">
          <div className="area-row-title">
            <h2 className="page-title">{detail.opportunity.title}</h2>
            <span className="area-row-sub">
              {detail.opportunity.number} · {detail.opportunity.contactName}
            </span>
          </div>
        </div>
        <OpportunityDetailClient
          userId={user.id}
          detail={detail}
          stages={stages}
          nowIso={new Date().toISOString()}
        />
      </div>
    </AreaWorkspaceShell>
  );
}
