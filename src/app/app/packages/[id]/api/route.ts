import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getPackageById } from '@/modules/packages/packages-service';
import { getPackageRelations } from '@/modules/cross-module/relationships-service';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('packages.view'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const { id } = await params;
  const pkg = await getPackageById(id);
  if (!pkg) return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  const relations = await getPackageRelations(pkg.zohoSalesOrderId, pkg.zohoCustomerId);
  return NextResponse.json({
    ...pkg,
    relatedSalesOrder: relations.salesOrder,
    relatedContact: relations.contact,
  });
}
