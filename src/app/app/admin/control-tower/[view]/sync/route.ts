import { NextResponse } from 'next/server';
import { EMPTY_CT_EXCEPTION_QUERY } from '@/components/control-tower/exceptions-model';
import { controlTowerErrorResponse, resolveControlTowerRoute } from '../../api/_ct-http';
import { listExceptionsPage } from '../_data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Actualizar" of the exceptions table. Exceptions are not synchronized from an
 * external system: they are read live from PostgreSQL, so this endpoint simply
 * recounts them and lets the table refetch, answering with the shape the shared
 * workspace expects.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ view: string }> }) {
  const { view } = await params;
  if (view !== 'excepciones') {
    return NextResponse.json({ error: 'Esta vista no tiene tabla' }, { status: 404 });
  }
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;

  try {
    const page = await listExceptionsPage(context.user, {
      ...EMPTY_CT_EXCEPTION_QUERY,
      page: 1,
      page_size: 5,
    });
    return NextResponse.json({
      already_running: false,
      result: { details_fetched: page.pagination.total },
    });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}
