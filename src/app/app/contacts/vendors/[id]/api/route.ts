import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getContactById } from '@/modules/contacts/contacts-service';
import { isEntityWatched } from '@/modules/sales/entity-watch-service';
import { CONTACT_ENTITY_TYPE_VENDOR } from '@/modules/contacts/permissions';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('vendors.view')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const { id } = await params;
  const contact = await getContactById(id);
  if (!contact) {
    return NextResponse.json({ error: 'Proveedor no encontrado' }, { status: 404 });
  }

  const isWatched = await isEntityWatched(session.user.id, CONTACT_ENTITY_TYPE_VENDOR, id);

  return NextResponse.json({ ...contact, is_watched: isWatched });
}
