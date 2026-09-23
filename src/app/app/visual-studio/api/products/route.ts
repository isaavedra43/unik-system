import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { searchProducts } from '@/modules/visual-studio/visual-service';
import { storageErrorResponse } from '@/app/app/files/api/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const search = request.nextUrl.searchParams.get('search') ?? '';
  try {
    const products = await searchProducts(session.user, search);
    return NextResponse.json({
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        rate: p.rate?.toString() ?? null,
        unit: p.unit,
        status: p.status,
        mediaCount: p._count.media,
      })),
    });
  } catch (err) {
    return storageErrorResponse(err);
  }
}
