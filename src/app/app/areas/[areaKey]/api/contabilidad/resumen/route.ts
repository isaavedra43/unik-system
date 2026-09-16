import { NextResponse } from 'next/server';
import { loadFinanceSummaryView } from '@/modules/areas/contabilidad/queries';
import { areaErrorResponse } from '../../../_area-http';
import { param, resolveContabilidadRoute } from '../_contabilidad-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resumen del libro: presupuesto contra real del periodo (`?periodo=YYYY-MM`) y
 * el avance del cierre diario y mensual con sus bloqueos.
 */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveContabilidadRoute(areaKey);
  if (!context.ok) return context.response;
  const url = new URL(request.url);
  try {
    const view = await loadFinanceSummaryView(context.user, {
      ...(param(url, 'periodo') ? { periodKey: param(url, 'periodo') as string } : {}),
    });
    return NextResponse.json(view);
  } catch (error) {
    return areaErrorResponse(error);
  }
}
