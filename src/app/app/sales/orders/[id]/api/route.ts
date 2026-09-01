import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getSalesOrderById } from '@/modules/sales/sales-orders-service';
import { getSalesOrderChangeEvents } from '@/modules/sales/sales-orders-change-events';
import { isEntityWatched } from '@/modules/sales/entity-watch-service';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('sales_orders.view')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const { id } = await params;
  const order = await getSalesOrderById(id);
  if (!order) {
    return NextResponse.json({ error: 'Orden no encontrada' }, { status: 404 });
  }

  const [changeEvents, isWatched] = await Promise.all([
    getSalesOrderChangeEvents(id, 20),
    isEntityWatched(session.user.id, 'sales_order', id),
  ]);

  return NextResponse.json({ ...order, change_events: changeEvents, is_watched: isWatched });
}
