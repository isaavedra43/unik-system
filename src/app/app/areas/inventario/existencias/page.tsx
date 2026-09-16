import { notFound } from 'next/navigation';
import { AreaWorkspaceShell } from '@/components/areas/AreaWorkspaceShell';
import { StockTable } from '@/components/areas/inventario/StockTable';
import {
  INVENTORY_SPACES,
  summarizeExpectedSupply,
} from '@/components/areas/inventario/inventario-model';
import { hasAnyPermission, requireAnyPermission } from '@/modules/auth/authorization';
import { findAreaSpace, getArea } from '@/modules/areas/area-registry';
import { getInventoryFilterOptions } from '@/modules/areas/inventario/inventory-area-queries';
import { listStockByConfidence } from '@/modules/inventory/inventory-queries';
import { listExpectedSupply } from '@/modules/purchases/purchases-queries';
import { isConfidenceLevel, type ConfidenceLevel } from '@/modules/inventory/inventory-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Existencias (plan 7.6): stock by product with its confidence, what is known,
 * available, reserved and blocked, plus the Zoho figures as an informational
 * column. The filters live in the URL, so the view is shareable.
 *
 * «Por llegar» comes from Compras (`listExpectedSupply`, ONE query for the
 * whole page) and is shown APART from the stock, never added to it: material a
 * supplier still owes is expected, never available. That read admits
 * `inventory.view`, so the warehouse sees what is coming without holding any
 * purchases permission.
 */
export default async function InventoryStockPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const area = getArea('inventario');
  if (!area) notFound();
  const user = await requireAnyPermission(['inventory.view']);
  const space = findAreaSpace(area, INVENTORY_SPACES.stock);

  const params = await searchParams;
  const single = (key: string): string => {
    const value = params[key];
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' ? first : '';
  };
  const pageNumber = Number.parseInt(single('page') || '1', 10);
  const confidence = single('confianza');
  const warehouse = single('bodega');
  const now = new Date();

  const [result, options] = await Promise.all([
    listStockByConfidence(user, {
      page: Number.isFinite(pageNumber) ? Math.max(1, pageNumber) : 1,
      pageSize: 25,
      search: single('q') || null,
      warehouseId: warehouse || null,
      ...(isConfidenceLevel(confidence) ? { confidence: confidence as ConfidenceLevel } : {}),
    }),
    getInventoryFilterOptions(user),
  ]);

  const expected = summarizeExpectedSupply(
    await listExpectedSupply(user, {
      zohoItemIds: result.rows.map((row) => row.zohoItemId),
      now,
    })
  );

  return (
    <AreaWorkspaceShell area={area} user={user} activeSlug={INVENTORY_SPACES.stock}>
      <div className="area-space">
        <p className="area-space-description">
          {space?.description ??
            'Existencias por artículo con su confianza, disponible y reservado.'}{' '}
          Las cifras de Zoho se muestran sólo como referencia: el inventario propio es el que manda.
        </p>
        <StockTable
          rows={result.rows}
          pagination={{
            page: result.page,
            pageSize: result.pageSize,
            total: result.total,
            pageCount: result.pageCount,
          }}
          query={{
            q: single('q'),
            bodega: warehouse,
            confianza: isConfidenceLevel(confidence) ? confidence : '',
            page: result.page,
          }}
          warehouses={options.warehouses}
          expectedByItem={expected}
          now={now.toISOString()}
          areaKey={area.key}
          /* Registrar un movimiento, un ajuste, un bloqueo o un compromiso
             previo al corte; cada comando revisa su propia llave otra vez. */
          canCapture={hasAnyPermission(user, [
            'inventory.manage',
            'inventory.adjust',
            'inventory.reserve',
          ])}
        />
      </div>
    </AreaWorkspaceShell>
  );
}
