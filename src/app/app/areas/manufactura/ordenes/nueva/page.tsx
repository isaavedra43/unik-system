import { prisma } from '@/lib/prisma';
import { PageHeader, TabNav } from '@/components/ui/composite';
import { NewOrderForm } from '@/components/areas/manufactura/NewOrderForm';
import { requirePermission } from '@/modules/auth/authorization';
import { manufacturaSectionTabs } from '@/modules/areas/manufactura/manufactura-sections';
import { listWorkCenters } from '@/modules/manufacturing/manufacturing-queries';
import '@/styles/operations/manufactura.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Nueva orden de transformación: insumo → producto con cantidades, la forma por
 * defecto de producir (plan 6.2). Las listas de materiales viven en su propia
 * página y sólo hacen falta para productos repetibles.
 */
export default async function NewProductionOrderPage() {
  const user = await requirePermission('manufacturing.manage_orders');
  const [centers, warehouses] = await Promise.all([
    listWorkCenters(user, { status: 'active' }),
    prisma.warehouse.findMany({
      where: { active: true },
      orderBy: [{ name: 'asc' }],
      select: { id: true, name: true },
    }),
  ]);

  // Quien sólo tenga `manufacturing.manage_orders` no ve ninguna sección (todas
  // piden ver manufactura): la tira desaparece en vez de ofrecer un 403.
  const tabs = manufacturaSectionTabs(user);

  return (
    <div className="mfg-order">
      <PageHeader
        title="Nueva orden de producción"
        description="Transformación rápida: el material de entrada se convierte en el producto de salida, con su merma y su sobrante."
      />
      {tabs.length > 1 ? <TabNav activeId="ordenes" tabs={tabs} /> : null}
      <NewOrderForm
        centers={centers.map((center) => ({ id: center.id, name: center.name }))}
        warehouses={warehouses}
      />
    </div>
  );
}
