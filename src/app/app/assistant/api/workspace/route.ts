import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { workspaceStatus } from '@/modules/agents/workspace-service';
import { DEFAULT_TENANT_ID } from '@/modules/agents/tenancy';

/** GET /app/assistant/api/workspace — quién tiene la venue central ahora. */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }
  const status = await workspaceStatus(session.user.id, session.user.tenantId ?? DEFAULT_TENANT_ID);
  return NextResponse.json(status);
}
