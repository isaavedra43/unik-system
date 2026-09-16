import { NextResponse } from 'next/server';
import { loadExpenseCaptureView } from '@/modules/areas/contabilidad/queries';
import { areaErrorResponse } from '../../../../_area-http';
import { resolveContabilidadRoute } from '../../_contabilidad-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Un gasto capturado con su catálogo: lo que la pantalla de captura relee
 * mientras la IA propone los campos del ticket y mientras se resuelve un
 * posible duplicado. `getExpense` deja ver el gasto a Contabilidad o a quien lo
 * capturó, nunca a nadie más.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string; expenseId: string }> }
) {
  const { areaKey, expenseId } = await params;
  const context = await resolveContabilidadRoute(areaKey);
  if (!context.ok) return context.response;
  try {
    const view = await loadExpenseCaptureView(context.user, {
      expenseId: decodeURIComponent(expenseId),
    });
    return NextResponse.json(view);
  } catch (error) {
    return areaErrorResponse(error);
  }
}
