import { NextResponse } from 'next/server';
import { loadBudgetsView } from '@/modules/areas/contabilidad/queries';
import { areaErrorResponse } from '../../../_area-http';
import { param, resolveContabilidadRoute } from '../_contabilidad-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Presupuesto del periodo (`?periodo=YYYY-MM`) y su comparación contra el real. */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveContabilidadRoute(areaKey);
  if (!context.ok) return context.response;
  const url = new URL(request.url);
  try {
    const view = await loadBudgetsView(context.user, {
      ...(param(url, 'periodo') ? { periodKey: param(url, 'periodo') as string } : {}),
    });
    return NextResponse.json(view);
  } catch (error) {
    return areaErrorResponse(error);
  }
}
