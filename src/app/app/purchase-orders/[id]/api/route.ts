import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getPurchaseOrderById } from '@/modules/purchase-orders/purchase-orders-service';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('purchase_orders.view')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const { id } = await params;
  const purchaseOrder = await getPurchaseOrderById(id);
  if (!purchaseOrder) {
    return NextResponse.json({ error: 'Orden de compra no encontrada' }, { status: 404 });
  }

  return NextResponse.json(purchaseOrder);
}
