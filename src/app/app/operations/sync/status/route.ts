import { NextResponse } from 'next/server';
import { requireOperationsUser } from '../../api/_http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sync status of the case list. Cases come straight from PostgreSQL, so there
 * is never a run in flight: the shared workspace stops polling and shows no
 * stale "last sync" label.
 */
export async function GET() {
  const auth = await requireOperationsUser();
  if ('response' in auth) return auth.response;
  return NextResponse.json({ active_run: null, latest_run: null });
}
