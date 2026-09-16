import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DriverApp } from '@/components/areas/logistica/DriverApp';
import { PageHeader } from '@/components/ui/composite';
import { hasPermission, requireAuthenticatedUser } from '@/modules/auth/authorization';
import { getArea } from '@/modules/areas/area-registry';
import { getDriverToday } from '@/modules/logistics/driver-service';
import {
  DISPATCH_PATH,
  LOGISTICS_AREA_KEY,
  parseBoardDate,
} from '@/modules/areas/logistica/logistics-view-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Vista de chofer (plan 6.3 y 7.1: `/app/areas/logistica/chofer`). Pantalla de
 * teléfono: el viaje del día, las paradas en orden y el registro de cada
 * entrega, todo por comandos con cola offline.
 *
 * La abre quien conduce (`logistics.drive`) o quien despacha
 * (`logistics.dispatch`). El service worker la precachea para que abra sin
 * señal; lo que el chofer registre sin conexión se envía solo al volver.
 */
export default async function DriverPage({
  params,
  searchParams,
}: {
  params: Promise<{ areaKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { areaKey } = await params;
  const area = getArea(areaKey);
  if (!area || area.key !== LOGISTICS_AREA_KEY) notFound();

  const user = await requireAuthenticatedUser();
  if (!hasPermission(user, 'logistics.drive') && !hasPermission(user, 'logistics.dispatch')) {
    notFound();
  }

  const query = await searchParams;
  const raw = Array.isArray(query.fecha) ? query.fecha[0] : query.fecha;
  const now = new Date();
  const date = parseBoardDate(raw, now);
  const today = await getDriverToday(user, { now, date });

  return (
    <div className="area-space">
      <PageHeader
        title="Mi viaje"
        description="Tus paradas del día: llegar, entregar con evidencia y avisar si algo falla."
        actions={
          hasPermission(user, 'logistics.dispatch') ? (
            <Link className="btn btn-secondary btn-sm" href={DISPATCH_PATH}>
              Ir a Despacho
            </Link>
          ) : null
        }
      />
      <DriverApp
        user={{ id: user.id, name: user.name }}
        initial={today}
        nowIso={now.toISOString()}
      />
    </div>
  );
}
