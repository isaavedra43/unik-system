import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { invalidateConnectionCaches } from '@/modules/composio/composio-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/assistant/api/composio/callback?toolkit=&status=
 * Composio sends the user back here after authorizing. Nothing from the query
 * string is trusted or echoed: the outcome is re-read from Composio on the
 * extensions page.
 */
export async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  const target = new URL('/app/assistant/extensions', request.nextUrl.origin);
  if (!session) {
    target.searchParams.set('composio', 'unauthenticated');
    return NextResponse.redirect(target);
  }
  invalidateConnectionCaches(session.user.id);
  const toolkit = (request.nextUrl.searchParams.get('toolkit') ?? '').toLowerCase();
  if (/^[a-z0-9_]{1,64}$/.test(toolkit)) target.searchParams.set('toolkit', toolkit);
  target.searchParams.set(
    'composio',
    request.nextUrl.searchParams.get('status') === 'failed' ? 'failed' : 'done'
  );
  return NextResponse.redirect(target);
}
