import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { PackageShippingError, cancelPackageShipment, shipPackage } from '@/modules/packages/packages-shipping-service';
import { getPackageRelations } from '@/modules/cross-module/relationships-service';
import { ZodError } from 'zod';

export const runtime = 'nodejs';

async function guard() {
  const session = await getCurrentSession();
  if (!session) return { error: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  if (!hasPermission(session.user, 'packages.ship')) return { error: NextResponse.json({ error: 'Sin permiso para enviar paquetes' }, { status: 403 }) };
  return { user: session.user };
}

function fail(error: unknown) {
  if (error instanceof ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? 'Datos inválidos' }, { status: 400 });
  if (error instanceof PackageShippingError) return NextResponse.json({ error: error.message }, { status: error.status });
  console.error('packages.shipment.route', error);
  return NextResponse.json({ error: 'Error inesperado' }, { status: 500 });
}

async function withRelations<T extends { zohoSalesOrderId: string | null; zohoCustomerId: string | null }>(pkg: T) {
  const relations = await getPackageRelations(pkg.zohoSalesOrderId, pkg.zohoCustomerId);
  return { ...pkg, relatedSalesOrder: relations.salesOrder, relatedContact: relations.contact };
}

/** Create the shipment order (assign carrier) or update it when the package is already shipped. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g.error) return g.error;
  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await withRelations(await shipPackage(g.user, id, body)));
  } catch (error) {
    return fail(error);
  }
}

/** Delete the shipment order: the package goes back to "not shipped". */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g.error) return g.error;
  const { id } = await params;
  try {
    return NextResponse.json(await withRelations(await cancelPackageShipment(g.user, id)));
  } catch (error) {
    return fail(error);
  }
}
