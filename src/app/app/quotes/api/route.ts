import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getQuotesWorkspace } from '@/modules/quotes/quotes-service';
import { quoteQueryStateSchema } from '@/modules/quotes/quotes-filters';

export const runtime = 'nodejs';

function canView(user: { isSuperAdmin: boolean; permissionKeys: string[] }): boolean {
  return user.isSuperAdmin || user.permissionKeys.includes('quotes.view');
}

export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!canView(session.user)) return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  const { searchParams } = new URL(request.url);
  let sort: { field: string; direction: 'asc' | 'desc' }[] = [];
  if (searchParams.get('sort')) { try { sort = JSON.parse(searchParams.get('sort')!); } catch { sort = []; } }
  let filters = { logic: 'AND' as const, rules: [] };
  if (searchParams.get('filters')) { try { filters = JSON.parse(searchParams.get('filters')!); } catch { filters = { logic: 'AND', rules: [] }; } }

  const query = quoteQueryStateSchema.parse({
    search: searchParams.get('search') ?? '', filters, sort,
    segment: searchParams.get('segment') ?? 'all',
    page: searchParams.get('page') ? Number(searchParams.get('page')) : 1,
    page_size: searchParams.get('page_size') ? Number(searchParams.get('page_size')) : 50,
  });
  const result = await getQuotesWorkspace(query, session.user.id);
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!canView(session.user)) return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Cuerpo inválido' }, { status: 400 }); }
  const parsed = quoteQueryStateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Query inválida' }, { status: 400 });
  const result = await getQuotesWorkspace(parsed.data, session.user.id);
  return NextResponse.json(result);
}
