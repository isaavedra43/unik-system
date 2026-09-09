import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getProductById } from '@/modules/products/products-service';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('products.view')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const { id } = await params;
  const product = await getProductById(id);
  if (!product) {
    return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  }

  return NextResponse.json(product);
}
