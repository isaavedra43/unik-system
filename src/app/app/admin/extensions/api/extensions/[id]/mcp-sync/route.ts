import { NextRequest, NextResponse } from 'next/server';
import {
  requireExtensionsAdmin,
  extensionErrorResponse,
} from '@/app/app/assistant/api/extensions/_shared';
import { syncMcpCatalog } from '@/modules/extensions/mcp-client-service';
import { recordAuditEvent } from '@/modules/auth/audit-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** POST — discover the remote MCP tool catalog as a DRAFT version; changed tools get blocked until re-review. */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireExtensionsAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const result = await syncMcpCatalog(id, auth.user);
    await recordAuditEvent({
      actorUserId: auth.user.id,
      action: 'extension.mcp_synced',
      targetType: 'extension',
      targetId: id,
      metadata: {
        added: result.added.length,
        changed: result.changed.length,
        removed: result.removed.length,
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    return extensionErrorResponse(err);
  }
}
