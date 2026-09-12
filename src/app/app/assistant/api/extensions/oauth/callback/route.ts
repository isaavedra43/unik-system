import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { completeOAuth } from '@/modules/extensions/oauth-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/assistant/api/extensions/oauth/callback?code=&state=
 * Registered callback. Redirects back to the extensions page with the outcome
 * (never echoes tokens or codes in the redirect).
 */
export async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  const target = new URL('/app/assistant/extensions', request.nextUrl.origin);
  if (!session) {
    target.searchParams.set('oauth', 'unauthenticated');
    return NextResponse.redirect(target);
  }
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const providerError = request.nextUrl.searchParams.get('error');
  if (providerError || !code || !state) {
    target.searchParams.set('oauth', 'denied');
    return NextResponse.redirect(target);
  }
  try {
    const result = await completeOAuth(session.user, code, state);
    target.searchParams.set('oauth', 'connected');
    target.searchParams.set('extension', result.extensionId);
  } catch (err) {
    console.error('[oauth-callback]', err instanceof Error ? err.message : err);
    target.searchParams.set('oauth', 'failed');
  }
  return NextResponse.redirect(target);
}
