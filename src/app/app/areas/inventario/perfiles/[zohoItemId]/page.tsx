import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AreaWorkspaceShell } from '@/components/areas/AreaWorkspaceShell';
import { ProfileForm } from '@/components/areas/inventario/ProfileForm';
import { INVENTORY_SPACES, inventoryHref } from '@/components/areas/inventario/inventario-model';
import { hasAnyPermission, requireAnyPermission } from '@/modules/auth/authorization';
import { getArea } from '@/modules/areas/area-registry';
import { getProfilePageData } from '@/modules/areas/inventario/inventory-area-queries';
import { isOperationsError } from '@/modules/operations/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Perfil de inventario de un artículo (plan 7.6): unidad base, conversiones,
 * tolerancia, variables, política de rastreo y fuente por defecto. Se llega
 * desde Existencias, así que esa pestaña sigue marcada como activa.
 */
export default async function InventoryProfilePage({
  params,
}: {
  params: Promise<{ zohoItemId: string }>;
}) {
  const area = getArea('inventario');
  if (!area) notFound();
  const user = await requireAnyPermission(['inventory.view']);
  const { zohoItemId } = await params;

  const data = await getProfilePageData(user, decodeURIComponent(zohoItemId)).catch((error) => {
    if (isOperationsError(error) && error.code === 'not_found') return null;
    throw error;
  });
  if (!data) notFound();

  return (
    <AreaWorkspaceShell area={area} user={user} activeSlug={INVENTORY_SPACES.stock}>
      <div className="area-space">
        <p className="area-space-description">
          <Link href={inventoryHref(INVENTORY_SPACES.stock)}>← Existencias</Link> · Configura cómo
          se mide y se rastrea este artículo. Los cambios afectan a los conteos, las reservas y las
          promesas al cliente.
        </p>
        <ProfileForm data={data} canManage={hasAnyPermission(user, ['inventory.manage'])} />
      </div>
    </AreaWorkspaceShell>
  );
}
