import { NextResponse } from 'next/server';
import { loadCaseSummary } from '../../../_case-data';
import { jsonError, requireOperationsUser } from '../../_http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Compact case for the preview drawer of the list.
 *
 * Access is the case rule (`authorizeOperationsChannel('case')`), not
 * `operations.view`: a person who may see the list does not automatically open
 * every case. "Not found" and "not allowed" answer the same on purpose.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOperationsUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;

  try {
    const summary = await loadCaseSummary(auth.user, id);
    if (!summary) {
      return jsonError(404, 'No encontramos ese expediente o no tienes acceso', 'not_found');
    }
    return NextResponse.json({ summary });
  } catch (error) {
    console.error(
      JSON.stringify({
        component: 'operations-cases-api',
        event: 'summary_failed',
        caseId: id,
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return jsonError(500, 'No pudimos cargar el expediente', 'internal_error');
  }
}
