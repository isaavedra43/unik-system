import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getProductsWorkspace } from '@/modules/products/products-service';
import { productQueryStateSchema } from '@/modules/products/products-filters';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('products.view')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);

  let sort: { field: string; direction: 'asc' | 'desc' }[] = [];
  if (searchParams.get('sort')) {
    try {
      sort = JSON.parse(searchParams.get('sort')!);
    } catch {
      sort = [];
    }
  }

  let filters = { logic: 'AND' as const, rules: [] };
  if (searchParams.get('filters')) {
    try {
      filters = JSON.parse(searchParams.get('filters')!);
    } catch {
      filters = { logic: 'AND', rules: [] };
    }
  }

  const query = productQueryStateSchema.parse({
    search: searchParams.get('search') ?? '',
    filters,
    sort,
    page: searchParams.get('page') ? Number(searchParams.get('page')) : 1,
    page_size: searchParams.get('page_size') ? Number(searchParams.get('page_size')) : 50,
  });

  const result = await getProductsWorkspace(query);
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('products.view')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Cuerpo inválido' }, { status: 400 });
  }

  const query = productQueryStateSchema.parse(body);
  const result = await getProductsWorkspace(query);
  return NextResponse.json(result);
}
