import { NextResponse } from 'next/server';
import { CasesQueryError, parseCasesQuery } from '@/components/operations/case/cases-filters';
import { hasPermission } from '@/modules/auth/authorization';
import { isOperationsError } from '@/modules/operations/errors';
import { listCaseRows } from '../_cases-data';
import { jsonError, requireOperationsUser } from './_http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Rows of the case list. `EntityWorkspace` posts its query state to
 * `${basePath}/api`, so this is `POST /app/operations/api`.
 *
 * The query is validated against the column registry (`cases-filters.ts`): an
 * unknown field or an operator that does not fit its type is REJECTED with a
 * 422 in Spanish, never silently ignored.
 */
export async function POST(request: Request) {
  const auth = await requireOperationsUser();
  if ('response' in auth) return auth.response;
  if (!hasPermission(auth.user, 'operations.view')) {
    return jsonError(403, 'No tienes acceso a los expedientes', 'forbidden');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'JSON inválido', 'invalid_request');
  }

  try {
    const query = parseCasesQuery(body ?? {});
    return NextResponse.json(await listCaseRows(auth.user, query));
  } catch (error) {
    if (error instanceof CasesQueryError) {
      return NextResponse.json({ error: error.message, code: 'invalid_query' }, { status: 422 });
    }
    if (isOperationsError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus }
      );
    }
    console.error(
      JSON.stringify({
        component: 'operations-cases-api',
        event: 'list_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return jsonError(500, 'No pudimos cargar los expedientes', 'internal_error');
  }
}
