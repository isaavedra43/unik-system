import { NextResponse } from 'next/server';
import { getConversationCrmPanel } from '@/modules/crm/crm-queries';
import { resolveVentasRoute, ventasErrorResponse } from '../../_ventas-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Panel CRM de una conversación de la bandeja (`crm.view` + acceso a la cuenta
 * de la conversación, que valida el servicio). Lo consume
 * `ConversationCrmPanel` dentro de `ConversationView`: si la persona no tiene
 * CRM, la respuesta es 403 y el panel simplemente no se muestra.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ areaKey: string; conversationId: string }> }
) {
  const { areaKey, conversationId } = await params;
  const context = await resolveVentasRoute(areaKey);
  if (!context.ok) return context.response;
  try {
    const panel = await getConversationCrmPanel(context.user, decodeURIComponent(conversationId));
    return NextResponse.json({ panel });
  } catch (error) {
    return ventasErrorResponse(error);
  }
}
