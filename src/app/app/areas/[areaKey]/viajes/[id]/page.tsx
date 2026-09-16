import { notFound } from 'next/navigation';
import { AreaWorkspaceShell } from '@/components/areas/AreaWorkspaceShell';
import { TripDetailView } from '@/components/areas/logistica/TripDetailView';
import { requireAnyPermission } from '@/modules/auth/authorization';
import { areaViewPermissions, getArea } from '@/modules/areas/area-registry';
import { ensureAreaRegistrations } from '@/modules/areas/register-all';
import { getTripDetail } from '@/modules/areas/logistica/queries';
import { LOGISTICS_AREA_KEY } from '@/modules/areas/logistica/logistics-view-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Detalle de un viaje (plan 7.1: `/app/areas/logistica/viajes/[id]`).
 *
 * Esta ruta estática gana sobre `[space]/[id]` para el espacio «viajes», que
 * sólo declara Logística: cualquier otra área responde 404. El acceso es el del
 * área (permiso de vista de Logística u `operations.admin`) y las acciones las
 * vuelve a validar el motor.
 */
export default async function TripPage({
  params,
}: {
  params: Promise<{ areaKey: string; id: string }>;
}) {
  const { areaKey, id } = await params;
  const area = getArea(areaKey);
  if (!area || area.key !== LOGISTICS_AREA_KEY) notFound();

  const user = await requireAnyPermission(areaViewPermissions(area));
  await ensureAreaRegistrations();

  const now = new Date();
  const detail = await getTripDetail(user, decodeURIComponent(id), { now });
  if (!detail) notFound();

  return (
    <AreaWorkspaceShell area={area} user={user} activeSlug="viajes">
      <div className="area-space">
        <TripDetailView
          user={{ id: user.id, name: user.name }}
          data={detail}
          nowIso={now.toISOString()}
        />
      </div>
    </AreaWorkspaceShell>
  );
}
