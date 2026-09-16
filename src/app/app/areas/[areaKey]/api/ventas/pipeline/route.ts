import { NextResponse } from 'next/server';
import { getVentasPipeline } from '@/modules/areas/ventas/ventas-queries';
import { resolveVentasRoute, ventasErrorResponse } from '../_ventas-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Embudo comercial por etapa (`crm.view`): `?vendedor=` y `?q=` (texto). */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveVentasRoute(areaKey);
  if (!context.ok) return context.response;

  const search = new URL(request.url).searchParams;
  const salesperson = search.get('vendedor')?.trim();
  const text = search.get('q')?.trim();
  try {
    const pipeline = await getVentasPipeline(context.user, {
      ...(salesperson && salesperson !== 'all' ? { salesperson } : {}),
      ...(text ? { search: text.slice(0, 120) } : {}),
    });
    return NextResponse.json(pipeline);
  } catch (error) {
    return ventasErrorResponse(error);
  }
}
