import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getSalespersonsForQuote } from '@/modules/quotes/quotes-salespersons';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const allowed = session.user.isSuperAdmin || session.user.permissionKeys.includes('quotes.create') || session.user.permissionKeys.includes('quotes.edit');
  if (!allowed) return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const refresh = new URL(request.url).searchParams.get('refresh') === '1';
  const data = await getSalespersonsForQuote({ forceRefresh: refresh });
  return NextResponse.json({ data });
}
