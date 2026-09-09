import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getInvoicesWorkspace } from '@/modules/invoices/invoices-service';
import { invoiceQueryStateSchema } from '@/modules/invoices/invoices-filters';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('invoices.view'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });

  const { searchParams } = new URL(request.url);
  let sort: { field: string; direction: 'asc' | 'desc' }[] = [];
  if (searchParams.get('sort')) { try { sort = JSON.parse(searchParams.get('sort')!); } catch { sort = []; } }
  let filters = { logic: 'AND' as const, rules: [] };
  if (searchParams.get('filters')) { try { filters = JSON.parse(searchParams.get('filters')!); } catch { filters = { logic: 'AND', rules: [] }; } }

  const query = invoiceQueryStateSchema.parse({
    search: searchParams.get('search') ?? '', filters, sort,
    page: searchParams.get('page') ? Number(searchParams.get('page')) : 1,
    page_size: searchParams.get('page_size') ? Number(searchParams.get('page_size')) : 50,
  });
  const result = await getInvoicesWorkspace(query);
  return NextResponse.json(result);
}
