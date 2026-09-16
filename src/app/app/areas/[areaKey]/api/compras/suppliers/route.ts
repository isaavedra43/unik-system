import { NextResponse } from 'next/server';
import { listSuppliers } from '@/modules/purchases/purchases-queries';
import { areaErrorResponse } from '../../../_area-http';
import { readPage, readText, resolveComprasRoute } from '../_compras-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Suppliers of UNIK, used by the pickers (who to invite to an RFQ, who to buy
 * from). `?search=` matches name, folio, RFC, phone and the products they
 * quote; `?status=` defaults to the active ones, because a blocked supplier
 * must not be offered by mistake.
 */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveComprasRoute(areaKey);
  if (!context.ok) return context.response;

  const search = new URL(request.url).searchParams;
  const { page, pageSize } = readPage(search);
  const status = readText(search, 'status', 40) ?? 'active';

  try {
    const suppliers = await listSuppliers(context.user, {
      page,
      pageSize,
      status: status === 'all' ? undefined : status,
      ...(readText(search, 'search') ? { search: readText(search, 'search') } : {}),
    });
    return NextResponse.json({
      suppliers: suppliers.rows,
      pagination: {
        page: suppliers.page,
        pageSize: suppliers.pageSize,
        total: suppliers.total,
        pageCount: suppliers.pageCount,
      },
    });
  } catch (error) {
    return areaErrorResponse(error);
  }
}
