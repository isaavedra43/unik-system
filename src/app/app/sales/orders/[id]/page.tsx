import { notFound } from 'next/navigation';
import { requirePermission, hasPermission } from '@/modules/auth/authorization';
import { getSalesOrderById } from '@/modules/sales/sales-orders-service';
import { getSalesOrderChangeEvents } from '@/modules/sales/sales-orders-change-events';
import { isEntityWatched } from '@/modules/sales/entity-watch-service';
import { SalesOrderDetail } from '@/components/sales/SalesOrderDetail';

export const runtime = 'nodejs';

export default async function SalesOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission('sales_orders.view');
  const { id } = await params;

  const order = await getSalesOrderById(id);
  if (!order) notFound();

  const [changeEvents, isWatched] = await Promise.all([
    getSalesOrderChangeEvents(id, 50),
    isEntityWatched(user.id, 'sales_order', id),
  ]);

  return (
    <SalesOrderDetail
      order={order}
      changeEvents={changeEvents}
      isWatched={isWatched}
      canWatch={hasPermission(user, 'sales_orders.watch')}
    />
  );
}
