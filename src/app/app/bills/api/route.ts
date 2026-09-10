import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getBillsWorkspace } from '@/modules/bills/bills-service';
import { billQueryStateSchema } from '@/modules/bills/bills-filters';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('bills.view')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Cuerpo inválido' }, { status: 400 });
  }

  let query;
  try {
    query = billQueryStateSchema.parse(body);
  } catch {
    return NextResponse.json({ error: 'Query inválida' }, { status: 400 });
  }

  const result = await getBillsWorkspace(query);
  return NextResponse.json(result);
}
