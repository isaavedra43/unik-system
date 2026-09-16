import { NextResponse } from 'next/server';
import { createSalesOrderFromQuote } from '@/modules/crm/sales-order-write-service';
import { readOptionalJson, resolveVentasRoute, ventasErrorResponse } from '../../../_ventas-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * "Crear OV en Zoho" desde una cotización ACEPTADA (permiso
 * `crm.create_sales_order` + indicador `crmSalesOrderWrite`, ambos validados
 * por el servicio). Es la misma escritura que ejecuta la tool
 * `createSalesOrderFromQuote` cuando la aprueba una persona, con el mismo
 * ledger idempotente: repetir la acción no crea una segunda orden.
 *
 * La llave de solicitud es por cotización y persona (nunca por día): un
 * reintento, cualquier día, es la misma solicitud.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ areaKey: string; quoteId: string }> }
) {
  const { areaKey, quoteId } = await params;
  const context = await resolveVentasRoute(areaKey);
  if (!context.ok) return context.response;

  const body = await readOptionalJson(request);
  const quote = decodeURIComponent(quoteId);
  const opportunityId = typeof body.opportunityId === 'string' ? body.opportunityId : undefined;
  try {
    const result = await createSalesOrderFromQuote(context.user, {
      quoteId: quote,
      requestKey: `ui:so:${quote}:${context.user.id}`,
      ...(opportunityId ? { opportunityId } : {}),
    });
    return NextResponse.json({ result });
  } catch (error) {
    return ventasErrorResponse(error);
  }
}
