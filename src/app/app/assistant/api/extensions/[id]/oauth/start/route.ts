import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { hasPermission } from '@/modules/auth/authorization';
import { requireAssistantUser, extensionErrorResponse, readJson } from '../../../_shared';
import { beginOAuth } from '@/modules/extensions/oauth-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ scopeType: z.enum(['personal', 'team']).default('personal') });

/** POST — returns the provider authorization URL (state + PKCE persisted server-side). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = schema.parse(await readJson(request));
    const needed = body.scopeType === 'team' ? 'extensions.manage' : 'extensions.connect';
    if (!hasPermission(auth.user, needed))
      return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
    return NextResponse.json(await beginOAuth(auth.user, id, body.scopeType));
  } catch (err) {
    return extensionErrorResponse(err);
  }
}
