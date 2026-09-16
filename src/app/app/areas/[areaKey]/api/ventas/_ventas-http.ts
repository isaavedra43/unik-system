import { NextResponse } from 'next/server';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { AreaMeta } from '@/modules/areas/area-registry';
import { isCrmError } from '@/modules/crm/crm-helpers';
import { areaErrorResponse, resolveAreaRoute } from '../../_area-http';

/**
 * Guardas compartidas de las APIs de Ventas (`/app/areas/ventas/api/ventas/...`).
 *
 * Primero la regla del área (sesión + permiso de vista de Ventas o
 * `operations.admin`) y luego la del módulo CRM dentro de cada servicio
 * (`crm.view`, `crm.radar`, `crm.manage`, `crm.create_sales_order`): estas rutas
 * nunca deciden por sí mismas quién puede leer o escribir.
 */

export type VentasRouteContext =
  { ok: true; user: CurrentUser; area: AreaMeta } | { ok: false; response: NextResponse };

export async function resolveVentasRoute(areaKeyParam: string): Promise<VentasRouteContext> {
  const context = await resolveAreaRoute(areaKeyParam);
  if (!context.ok) return context;
  if (context.area.key !== 'ventas') {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Ruta sólo disponible en Ventas' }, { status: 404 }),
    };
  }
  return context;
}

/** Errores del CRM con su estado real; el resto los traduce el área. */
export function ventasErrorResponse(error: unknown): NextResponse {
  if (isCrmError(error)) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  return areaErrorResponse(error);
}

/** Cuerpo JSON opcional de un POST (un cuerpo vacío es válido). */
export async function readOptionalJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
