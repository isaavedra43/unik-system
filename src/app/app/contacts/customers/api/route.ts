import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getContactsWorkspace } from '@/modules/contacts/contacts-service';
import { contactQueryStateSchema } from '@/modules/contacts/contacts-filters';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('customers.view')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const parsed = contactQueryStateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Query inválida' }, { status: 400 });
  }

  try {
    const result = await getContactsWorkspace(parsed.data, 'customer');
    return NextResponse.json(result);
  } catch (error) {
    console.error('customers api error', error);
    return NextResponse.json({ error: 'Error interno' }, { status: 500 });
  }
}
