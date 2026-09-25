import { NextResponse } from 'next/server';
import { requireAssistantUser } from '../../../extensions/_shared';
import { composioErrorResponse } from '../../_shared';
import { disconnectToolkit } from '@/modules/composio/composio-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** DELETE /app/assistant/api/composio/connections/:id — disconnects one of the caller's own accounts. */
export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  try {
    const { id } = await ctx.params;
    await disconnectToolkit(auth.user, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return composioErrorResponse(err);
  }
}
