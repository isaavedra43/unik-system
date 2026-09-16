import { NextResponse } from 'next/server';
import { loadCatalogView } from '@/modules/areas/contabilidad/queries';
import { areaErrorResponse } from '../../../_area-http';
import { resolveContabilidadRoute } from '../_contabilidad-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Cuentas de caja y banco, categorías, centros de costo y empleados. */
export async function GET(_request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveContabilidadRoute(areaKey);
  if (!context.ok) return context.response;
  try {
    return NextResponse.json(await loadCatalogView(context.user));
  } catch (error) {
    return areaErrorResponse(error);
  }
}
