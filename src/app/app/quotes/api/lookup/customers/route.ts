import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { searchCustomersForQuote } from '@/modules/quotes/quotes-service';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const allowed = session.user.isSuperAdmin || session.user.permissionKeys.includes('quotes.create') || session.user.permissionKeys.includes('quotes.edit');
  if (!allowed) return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') ?? '').slice(0, 100);
  const rows = await searchCustomersForQuote(q, 20);
  return NextResponse.json({ data: rows });
}
