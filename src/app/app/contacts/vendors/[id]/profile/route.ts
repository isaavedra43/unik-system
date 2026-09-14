import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getContactById } from '@/modules/contacts/contacts-service';
import { getVendorProfile } from '@/modules/contacts/vendor-profile-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?recent=5 — totals and latest purchase orders / credits of a vendor (preview drawer). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'vendors.view')) return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  const { id } = await params;
  const contact = await getContactById(id);
  if (!contact || contact.contactType !== 'vendor') {
    return NextResponse.json({ error: 'Proveedor no encontrado' }, { status: 404 });
  }

  const recent = Number(request.nextUrl.searchParams.get('recent') ?? 5);
  try {
    const profile = await getVendorProfile(contact, {
      recent: Number.isFinite(recent) ? recent : 5,
      access: {
        purchaseOrders: hasPermission(session.user, 'purchase_orders.view'),
        bills: hasPermission(session.user, 'bills.view'),
        vendorCredits: hasPermission(session.user, 'vendor_credits.view'),
      },
    });
    return NextResponse.json(profile);
  } catch (error) {
    console.error('[vendor-profile]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'No se pudo cargar el resumen del proveedor' }, { status: 500 });
  }
}
