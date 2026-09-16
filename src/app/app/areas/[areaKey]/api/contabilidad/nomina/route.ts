import { NextResponse } from 'next/server';
import { loadPayrollView } from '@/modules/areas/contabilidad/queries';
import { areaErrorResponse } from '../../../_area-http';
import { param, resolveContabilidadRoute } from '../_contabilidad-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Corridas de nómina y, con `?corrida=<id>`, sus líneas por empleado. */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveContabilidadRoute(areaKey);
  if (!context.ok) return context.response;
  const url = new URL(request.url);
  try {
    const view = await loadPayrollView(context.user, {
      ...(param(url, 'corrida') ? { runId: param(url, 'corrida') as string } : {}),
    });
    return NextResponse.json(view);
  } catch (error) {
    return areaErrorResponse(error);
  }
}
