import { NextResponse } from 'next/server';
import { parseCasesQuery } from '@/components/operations/case/cases-filters';
import { hasPermission } from '@/modules/auth/authorization';
import { listCaseRows } from '../_cases-data';
import { jsonError, requireOperationsUser } from '../api/_http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Actualizar" of the case list. Cases are not synchronized from an external
 * system — they are read live from PostgreSQL — so this endpoint only recounts
 * the open cases and lets the table refetch. It answers with the shape the
 * shared workspace expects.
 */
export async function POST() {
  const auth = await requireOperationsUser();
  if ('response' in auth) return auth.response;
  if (!hasPermission(auth.user, 'operations.view')) {
    return jsonError(403, 'No tienes acceso a los expedientes', 'forbidden');
  }
  const query = parseCasesQuery({ scope: 'open', page: 1, page_size: 1 });
  const result = await listCaseRows(auth.user, query);
  return NextResponse.json({
    already_running: false,
    result: { details_fetched: result.pagination.total },
  });
}
