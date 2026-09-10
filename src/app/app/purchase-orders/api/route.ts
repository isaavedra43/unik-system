import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getPurchaseOrdersWorkspace } from '@/modules/purchase-orders/purchase-orders-service';
import { purchaseOrderQueryStateSchema } from '@/modules/purchase-orders/purchase-orders-filters';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (
    !session.user.isSuperAdmin &&
    !session.user.permissionKeys.includes('purchase_orders.view')
  ) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Cuerpo inválido' }, { status: 400 });
  }

  const query = purchaseOrderQueryStateSchema.parse(body);
  const result = await getPurchaseOrdersWorkspace(query);
  return NextResponse.json(result);
}
