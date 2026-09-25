import { NextRequest, NextResponse } from 'next/server';
import { requireAssistantUser } from '../../extensions/_shared';
import { composioErrorResponse } from '../_shared';
import { isComposioConfigured } from '@/modules/composio/composio-client';
import { listToolkits } from '@/modules/composio/composio-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /app/assistant/api/composio/toolkits — apps enabled for this user and whether they connected each. */
export async function GET(request: NextRequest) {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  if (!isComposioConfigured()) return NextResponse.json({ configured: false, toolkits: [] });
  try {
    const search = request.nextUrl.searchParams.get('search') ?? undefined;
    const toolkits = await listToolkits(auth.user, { search, limit: 50 });
    return NextResponse.json({ configured: true, toolkits });
  } catch (err) {
    return composioErrorResponse(err);
  }
}
