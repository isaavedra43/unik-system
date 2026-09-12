import { NextRequest, NextResponse } from 'next/server';
import { hasPermission } from '@/modules/auth/authorization';
import { requireAssistantUser, extensionErrorResponse } from '../../../_shared';
import { revokeConnection } from '@/modules/extensions/connections-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** DELETE — disconnect (revoke) a connection: own personal ones, or team ones for admins. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; connectionId: string }> }
) {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  const { connectionId } = await params;
  try {
    await revokeConnection(connectionId, auth.user, {
      allowTeam: hasPermission(auth.user, 'extensions.manage'),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return extensionErrorResponse(err);
  }
}
