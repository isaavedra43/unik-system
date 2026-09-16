import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { AreaWorkspaceShell } from '@/components/areas/AreaWorkspaceShell';
import { FleetManager } from '@/components/areas/logistica/FleetManager';
import { hasPermission, requireAnyPermission } from '@/modules/auth/authorization';
import { areaViewPermissions, getArea } from '@/modules/areas/area-registry';
import { ensureAreaRegistrations } from '@/modules/areas/register-all';
import { getFleetOverview } from '@/modules/areas/logistica/queries';
import {
  DISPATCH_PATH,
  LOGISTICS_AREA_KEY,
  parseBoardDate,
} from '@/modules/areas/logistica/logistics-view-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Flotilla (plan 7.1): unidades y choferes con su disponibilidad del día.
 *
 * Ver la flotilla es parte de ver el área; darla de alta o editarla exige
 * `logistics.manage_fleet`, y sólo entonces se carga la lista de personas que
 * se pueden ligar a un chofer.
 */
const LINKABLE_USERS_LIMIT = 200;

export default async function FleetPage({
  params,
  searchParams,
}: {
  params: Promise<{ areaKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { areaKey } = await params;
  const area = getArea(areaKey);
  if (!area || area.key !== LOGISTICS_AREA_KEY) notFound();

  const user = await requireAnyPermission(areaViewPermissions(area));
  await ensureAreaRegistrations();

  const query = await searchParams;
  const raw = Array.isArray(query.fecha) ? query.fecha[0] : query.fecha;
  const now = new Date();
  const date = parseBoardDate(raw, now);

  const canManage = hasPermission(user, 'logistics.manage_fleet');
  const [data, linkableUsers] = await Promise.all([
    getFleetOverview(user, { date, now }),
    canManage
      ? prisma.user.findMany({
          where: { isActive: true, isBot: false },
          orderBy: { name: 'asc' },
          take: LINKABLE_USERS_LIMIT,
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  return (
    <AreaWorkspaceShell area={area} user={user} activeSlug="flota" parentSlug="despacho">
      <div className="area-space">
        <p className="area-space-description">
          Unidades y choferes con su disponibilidad del día. Un chofer ligado a su usuario puede
          usar la vista de chofer en el teléfono.{' '}
          <Link href={DISPATCH_PATH}>Volver a Despacho</Link>
        </p>
        <FleetManager
          user={{ id: user.id, name: user.name }}
          data={data}
          linkableUsers={linkableUsers}
        />
      </div>
    </AreaWorkspaceShell>
  );
}
