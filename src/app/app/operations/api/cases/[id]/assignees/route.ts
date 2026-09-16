import { NextResponse } from 'next/server';
import { listCaseAssignees } from '../../../../_case-data';
import { jsonError, requireOperationsUser } from '../../../_http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * People who can take a work item of this case: the ones already taking part in
 * it plus the responsible and backup of every area. Only for somebody who can
 * open the case; the engine checks the new owner again when the command runs
 * (`workitem.reassign`).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOperationsUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;

  try {
    const users = await listCaseAssignees(auth.user, id);
    if (!users) {
      return jsonError(404, 'No encontramos ese expediente o no tienes acceso', 'not_found');
    }
    return NextResponse.json({ users });
  } catch (error) {
    console.error(
      JSON.stringify({
        component: 'operations-cases-api',
        event: 'assignees_failed',
        caseId: id,
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return jsonError(500, 'No pudimos cargar a las personas', 'internal_error');
  }
}
