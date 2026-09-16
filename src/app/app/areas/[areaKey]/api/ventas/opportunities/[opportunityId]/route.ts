import { NextResponse } from 'next/server';
import { getOpportunityDetail } from '@/modules/crm/crm-queries';
import { resolveVentasRoute, ventasErrorResponse } from '../../_ventas-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Detalle de una oportunidad por id o folio `OPP-000123` (`crm.view`): etapa,
 * actividades, cotizaciones, órdenes, expedientes, conversaciones y señales.
 * Las cotizaciones, órdenes y expedientes sólo se describen a quien puede
 * verlos en su propio módulo (lo aplica el servicio del CRM).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string; opportunityId: string }> }
) {
  const { areaKey, opportunityId } = await params;
  const context = await resolveVentasRoute(areaKey);
  if (!context.ok) return context.response;
  try {
    const detail = await getOpportunityDetail(context.user, decodeURIComponent(opportunityId));
    return NextResponse.json({ detail });
  } catch (error) {
    return ventasErrorResponse(error);
  }
}
