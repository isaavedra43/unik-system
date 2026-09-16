import { notFound } from 'next/navigation';
import { AreaWorkspaceShell } from '@/components/areas/AreaWorkspaceShell';
import { LocationsAdmin } from '@/components/areas/inventario/LocationsAdmin';
import { INVENTORY_SPACES } from '@/components/areas/inventario/inventario-model';
import { hasAnyPermission, requireAnyPermission } from '@/modules/auth/authorization';
import { findAreaSpace, getArea } from '@/modules/areas/area-registry';
import { listPrintableLabels } from '@/modules/areas/inventario/inventory-area-queries';
import { listInventoryWarehouses } from '@/modules/inventory/inventory-queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Bodegas, ubicaciones y etiquetas (plan 7.6). The labels carry the same QR
 * payloads the scanner understands (`unik:loc:<id>`, `unik:stock:<id>`), so
 * what is printed here is what the counting screen reads.
 */
export default async function InventoryLocationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const area = getArea('inventario');
  if (!area) notFound();
  const user = await requireAnyPermission(['inventory.view']);
  const space = findAreaSpace(area, INVENTORY_SPACES.locations);

  const params = await searchParams;
  const single = (key: string): string => {
    const value = params[key];
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' ? first : '';
  };

  const warehouses = await listInventoryWarehouses(user, { includeInactive: true });
  const requested = single('bodega');
  const selected =
    warehouses.find((warehouse) => warehouse.id === requested) ?? warehouses[0] ?? null;
  const labelKind = single('etiquetas') === 'contenedores' ? 'container' : 'location';
  const labels = selected
    ? await listPrintableLabels(user, { warehouseId: selected.id, kind: labelKind })
    : [];

  return (
    <AreaWorkspaceShell area={area} user={user} activeSlug={INVENTORY_SPACES.locations}>
      <div className="area-space">
        <p className="area-space-description inv-no-print">
          {space?.description ?? 'Bodegas, ubicaciones y etiquetas para imprimir.'} Las ubicaciones
          GENERAL y SCRAP las administra el sistema.
        </p>
        <LocationsAdmin
          warehouses={warehouses}
          selectedWarehouseId={selected?.id ?? null}
          labels={labels}
          labelKind={labelKind}
          canManage={hasAnyPermission(user, ['inventory.manage'])}
        />
      </div>
    </AreaWorkspaceShell>
  );
}
