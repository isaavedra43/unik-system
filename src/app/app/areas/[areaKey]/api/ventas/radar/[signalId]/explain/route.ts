import { NextResponse } from 'next/server';
import { explainSignal } from '@/modules/crm/radar-service';
import { readOptionalJson, resolveVentasRoute, ventasErrorResponse } from '../../../_ventas-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Explicación de una señal y borrador del mensaje para el cliente
 * (`crm.radar`). Reutiliza `explainSignal`: una sola llamada al modelo
 * `utility`, frenada por el presupuesto de la identidad de IA de Ventas, y con
 * la explicación guardada de las últimas 12 h salvo `{"force": true}`.
 *
 * El borrador NO se envía: se muestra en el radar para que la persona lo revise
 * y lo mande desde la bandeja.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ areaKey: string; signalId: string }> }
) {
  const { areaKey, signalId } = await params;
  const context = await resolveVentasRoute(areaKey);
  if (!context.ok) return context.response;

  const body = await readOptionalJson(request);
  try {
    const signal = await explainSignal(context.user, {
      signalId: decodeURIComponent(signalId),
      force: body.force === true,
    });
    return NextResponse.json({ signal });
  } catch (error) {
    return ventasErrorResponse(error);
  }
}
