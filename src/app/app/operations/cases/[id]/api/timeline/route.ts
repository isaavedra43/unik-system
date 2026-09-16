import { NextRequest, NextResponse } from 'next/server';
import { isOperationsError } from '@/modules/operations/errors';
import { loadCaseTimelinePage } from '../../../../_case-data';
import { jsonError, requireOperationsUser } from '../../../../api/_http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Older page of the case timeline ("Ver historia anterior"). `beforeId` is the
 * cursor the previous page returned; it is validated by the events service
 * (digits only), so nothing a person types reaches the query as text.
 *
 * Access is the case rule (`authorizeOperationsChannel('case')`).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOperationsUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  const beforeId = request.nextUrl.searchParams.get('beforeId') ?? '';
  if (!/^\d{1,19}$/.test(beforeId)) {
    return jsonError(400, 'Cursor inválido', 'invalid_request');
  }

  try {
    const page = await loadCaseTimelinePage(auth.user, id, beforeId);
    if (!page) {
      return jsonError(404, 'No encontramos ese expediente o no tienes acceso', 'not_found');
    }
    return NextResponse.json(page);
  } catch (error) {
    if (isOperationsError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus }
      );
    }
    console.error(
      JSON.stringify({
        component: 'operations-cases-api',
        event: 'timeline_failed',
        caseId: id,
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return jsonError(500, 'No pudimos cargar más historia', 'internal_error');
  }
}
