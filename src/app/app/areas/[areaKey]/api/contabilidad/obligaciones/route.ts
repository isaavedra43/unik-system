import { NextResponse } from 'next/server';
import { loadObligationsView } from '@/modules/areas/contabilidad/queries';
import { areaErrorResponse } from '../../../_area-http';
import { pageParam, param, resolveContabilidadRoute } from '../_contabilidad-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Obligaciones por pagar y por cobrar con su antigüedad:
 * `?tipo=payable|receivable&estado=&bucket=&vencidas=1&buscar=&pagina=`.
 */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveContabilidadRoute(areaKey);
  if (!context.ok) return context.response;
  const url = new URL(request.url);
  const kind = param(url, 'tipo');
  try {
    const view = await loadObligationsView(context.user, {
      ...(kind === 'payable' || kind === 'receivable' ? { kind } : {}),
      ...(param(url, 'estado') ? { status: param(url, 'estado') as string } : {}),
      ...(param(url, 'bucket') ? { agingBucket: param(url, 'bucket') as string } : {}),
      ...(url.searchParams.get('vencidas') === '1' ? { overdueOnly: true } : {}),
      ...(param(url, 'buscar') ? { search: param(url, 'buscar') as string } : {}),
      ...(pageParam(url) ? { page: pageParam(url) as number } : {}),
    });
    return NextResponse.json(view);
  } catch (error) {
    return areaErrorResponse(error);
  }
}
