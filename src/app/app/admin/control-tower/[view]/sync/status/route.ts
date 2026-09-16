import { NextResponse } from 'next/server';
import { resolveControlTowerRoute } from '../../../api/_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sync status of the exceptions table. The rows come straight from PostgreSQL,
 * so there is never a run in flight: the shared workspace stops polling and
 * shows no stale "última sincronización" label.
 */
export async function GET() {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  return NextResponse.json({ active_run: null, latest_run: null });
}
