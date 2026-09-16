import { NextResponse } from 'next/server';
import { loadCashBookView } from '@/modules/areas/contabilidad/queries';
import { areaErrorResponse } from '../../../_area-http';
import { pageParam, param, resolveContabilidadRoute } from '../_contabilidad-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Libro de caja de una cuenta: `?cuenta=&desde=&hasta=&pagina=`.
 * Devuelve las cuentas, el renglonaje con su saldo corrido y lo que la persona
 * puede hacer con él.
 */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveContabilidadRoute(areaKey);
  if (!context.ok) return context.response;
  const url = new URL(request.url);
  try {
    const view = await loadCashBookView(context.user, {
      ...(param(url, 'cuenta') ? { accountId: param(url, 'cuenta') as string } : {}),
      ...(param(url, 'desde') ? { from: param(url, 'desde') as string } : {}),
      ...(param(url, 'hasta') ? { to: param(url, 'hasta') as string } : {}),
      ...(pageParam(url) ? { page: pageParam(url) as number } : {}),
    });
    return NextResponse.json(view);
  } catch (error) {
    return areaErrorResponse(error);
  }
}
