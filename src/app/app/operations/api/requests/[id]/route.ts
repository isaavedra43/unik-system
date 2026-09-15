import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getAreaRequest } from '@/modules/operations/area-requests-service';
import { jsonError, operationsCopilotErrorResponse, requireOperationsUser } from '../../_http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * GET — live status of an area request for the chat cards (the card meta is written once when it is
 * posted). `getAreaRequest` applies the access rule of the request (participants, requester, case
 * owner, people of either area); anyone else gets 404. Only the status fields are returned.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOperationsUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  if (!ID_PATTERN.test(id)) return jsonError(404, 'No se encontró la solicitud', 'not_found');
  try {
    const request = await getAreaRequest(auth.user, id);
    return NextResponse.json({
      request: { id: request.id, status: request.status, closed: request.closedAt !== null },
    });
  } catch (err) {
    return operationsCopilotErrorResponse(err);
  }
}
