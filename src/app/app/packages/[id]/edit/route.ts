import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { PackageShippingError, editPackage } from '@/modules/packages/packages-shipping-service';
import { getPackageRelations } from '@/modules/cross-module/relationships-service';

export const runtime = 'nodejs';

/** Edit the package's date / notes in Zoho. Body: { date?: 'YYYY-MM-DD', notes?: string } */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'packages.edit')) return NextResponse.json({ error: 'Sin permiso para editar paquetes' }, { status: 403 });
  const { id } = await params;
  try {
    const pkg = await editPackage(session.user, id, await request.json().catch(() => ({})));
    const relations = await getPackageRelations(pkg.zohoSalesOrderId, pkg.zohoCustomerId);
    return NextResponse.json({ ...pkg, relatedSalesOrder: relations.salesOrder, relatedContact: relations.contact });
  } catch (error) {
    if (error instanceof ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? 'Datos inválidos' }, { status: 400 });
    if (error instanceof PackageShippingError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('packages.edit.route', error);
    return NextResponse.json({ error: 'Error inesperado' }, { status: 500 });
  }
}
