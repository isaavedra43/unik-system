import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getSalesOrdersWorkspace } from '@/modules/sales/sales-orders-service';
import { salesOrderQueryStateSchema } from '@/modules/sales/sales-orders-filters';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('sales_orders.view')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const parsed = salesOrderQueryStateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Query inválida' }, { status: 400 });
  }

  try {
    const result = await getSalesOrdersWorkspace(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    console.error('sales orders api error', error);
    return NextResponse.json({ error: 'Error interno' }, { status: 500 });
  }
}
