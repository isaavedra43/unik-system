import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { PackageShippingError, markPackageDelivered } from '@/modules/packages/packages-shipping-service';
import { getPackageRelations } from '@/modules/cross-module/relationships-service';

export const runtime = 'nodejs';

/** Mark the shipment as delivered in Zoho. Body: { deliveredDate?: 'YYYY-MM-DD' } */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'packages.ship')) return NextResponse.json({ error: 'Sin permiso para enviar paquetes' }, { status: 403 });
  const { id } = await params;
  try {
    const body = (await request.json().catch(() => ({}))) as { deliveredDate?: string | null };
    const pkg = await markPackageDelivered(session.user, id, body.deliveredDate ?? null);
    const relations = await getPackageRelations(pkg.zohoSalesOrderId, pkg.zohoCustomerId);
    return NextResponse.json({ ...pkg, relatedSalesOrder: relations.salesOrder, relatedContact: relations.contact });
  } catch (error) {
    if (error instanceof PackageShippingError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('packages.delivered.route', error);
    return NextResponse.json({ error: 'Error inesperado' }, { status: 500 });
  }
}
