import { NextResponse } from 'next/server';
import { loadCloseView } from '@/modules/areas/contabilidad/queries';
import { areaErrorResponse } from '../../../_area-http';
import { resolveContabilidadRoute } from '../_contabilidad-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Estado del cierre: el día y el mes que tocan cerrar, sus revisiones con los
 * bloqueos y las cuentas cuyo arqueo pide el cierre diario, con el saldo del
 * libro al corte.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveContabilidadRoute(areaKey);
  if (!context.ok) return context.response;
  try {
    return NextResponse.json(await loadCloseView(context.user));
  } catch (error) {
    return areaErrorResponse(error);
  }
}
