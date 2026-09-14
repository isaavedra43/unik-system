import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getContactById } from '@/modules/contacts/contacts-service';
import { listVendorTransactions } from '@/modules/contacts/vendor-profile-service';
import { parsePageParams, parseVendorTransactionType, type VendorTransactionType } from '@/modules/contacts/vendor-profile-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TYPE_PERMISSION: Record<VendorTransactionType, 'purchase_orders.view' | 'bills.view' | 'vendor_credits.view'> = {
  purchase_orders: 'purchase_orders.view',
  bills: 'bills.view',
  vendor_credits: 'vendor_credits.view',
};

/** GET ?type=purchase_orders|bills|vendor_credits&page=&pageSize=&status= — full history of a vendor. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  const type = parseVendorTransactionType(sp.get('type'));
  if (!type) return NextResponse.json({ error: 'Tipo inválido' }, { status: 400 });
  if (!hasPermission(session.user, 'vendors.view') || !hasPermission(session.user, TYPE_PERMISSION[type])) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const { id } = await params;
  const contact = await getContactById(id);
  if (!contact || contact.contactType !== 'vendor') {
    return NextResponse.json({ error: 'Proveedor no encontrado' }, { status: 404 });
  }

  const { page, pageSize } = parsePageParams(sp.get('page'), sp.get('pageSize'));
  const status = sp.get('status')?.trim() || null;
  try {
    return NextResponse.json(await listVendorTransactions(contact.zohoContactId, type, { page, pageSize, status }));
  } catch (error) {
    console.error('[vendor-transactions]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'No se pudo cargar el historial' }, { status: 500 });
  }
}
