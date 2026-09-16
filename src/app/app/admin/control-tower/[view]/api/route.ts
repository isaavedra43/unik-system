import { NextResponse } from 'next/server';
import { CtExceptionQueryError } from '@/components/control-tower/exceptions-model';
import {
  controlTowerErrorResponse,
  readJsonBody,
  resolveControlTowerRoute,
} from '../../api/_ct-http';
import { listExceptionsPage } from '../_data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Rows of the exceptions table: `EntityWorkspace` posts its query state to
 * `${basePath}/api`, and its base path is `/app/admin/control-tower/excepciones`.
 *
 * Only that view answers — the other views are not tables — and the query is a
 * white list (`parseCtExceptionQuery`): an unknown sort or filter field is a
 * 422, never a silently ignored filter.
 */
export async function POST(request: Request, { params }: { params: Promise<{ view: string }> }) {
  const { view } = await params;
  if (view !== 'excepciones') {
    return NextResponse.json({ error: 'Esta vista no tiene tabla' }, { status: 404 });
  }
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  try {
    const page = await listExceptionsPage(context.user, body.value ?? {});
    return NextResponse.json({ data: page.data, pagination: page.pagination, counts: page.counts });
  } catch (error) {
    if (error instanceof CtExceptionQueryError) {
      return NextResponse.json({ error: error.message, code: 'invalid_query' }, { status: 422 });
    }
    return controlTowerErrorResponse(error);
  }
}
