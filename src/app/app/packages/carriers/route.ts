import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getCarrierOptions } from '@/modules/packages/packages-shipping-service';

export const runtime = 'nodejs';

/** Carrier names known from Zoho shipments, most used first. */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'packages.view')) return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  return NextResponse.json({ carriers: await getCarrierOptions() });
}
