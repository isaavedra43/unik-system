import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { listIntegrationApiCalls } from '@/modules/integrations/integration-api-call-logger';

export const runtime = 'nodejs';

/**
 * GET /app/admin/integrations/api/calls?source=zoho&limit=100&onlyErrors=true&offset=0
 * Returns recent API calls for a source, newest first.
 */
export async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  if (
    !session.user.isSuperAdmin &&
    !session.user.permissionKeys.includes('integrations.view')
  ) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const source = searchParams.get('source') ?? 'zoho';
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '100', 10) || 100, 500);
  const offset = parseInt(searchParams.get('offset') ?? '0', 10) || 0;
  const onlyErrors = searchParams.get('onlyErrors') === 'true';

  try {
    const calls = await listIntegrationApiCalls(source, { limit, onlyErrors, offset });
    return NextResponse.json({
      data: calls.map((c) => ({
        id: c.id,
        source: c.source,
        method: c.method,
        path: c.path,
        httpStatus: c.httpStatus,
        durationMs: c.durationMs,
        success: c.success,
        errorCode: c.errorCode,
        responsePreview: c.responsePreview,
        createdAt: c.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('integration calls GET error', error);
    return NextResponse.json({ error: 'Error al obtener llamadas' }, { status: 500 });
  }
}
