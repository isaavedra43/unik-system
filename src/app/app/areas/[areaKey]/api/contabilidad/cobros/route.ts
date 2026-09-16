import { NextResponse } from 'next/server';
import { loadCollectionsView } from '@/modules/areas/contabilidad/queries';
import { areaErrorResponse } from '../../../_area-http';
import { resolveContabilidadRoute } from '../_contabilidad-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cobros de Zoho que todavía no se asignan a una cuenta por cobrar, con las
 * cuentas abiertas a las que se pueden aplicar y las categorías de ingreso para
 * un cobro inesperado.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveContabilidadRoute(areaKey);
  if (!context.ok) return context.response;
  try {
    return NextResponse.json(await loadCollectionsView(context.user));
  } catch (error) {
    return areaErrorResponse(error);
  }
}
