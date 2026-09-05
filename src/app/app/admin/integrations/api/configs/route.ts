import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  listIntegrationConfigs,
  updateIntegrationConfig,
  type IntegrationSourceKey,
} from '@/modules/integrations/integration-config-service';

export const runtime = 'nodejs';

/**
 * GET /app/admin/integrations/api/configs
 * Returns all integration config rows.
 */
export async function GET() {
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

  try {
    const configs = await listIntegrationConfigs();
    return NextResponse.json({
      data: configs.map((c) => ({
        id: c.id,
        source: c.source,
        displayName: c.displayName,
        isEnabled: c.isEnabled,
        settings: c.settings,
        updatedAt: c.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('integration configs GET error', error);
    return NextResponse.json({ error: 'Error al obtener configuraciones' }, { status: 500 });
  }
}

/**
 * PATCH /app/admin/integrations/api/configs
 * Body: { source: string, isEnabled?: boolean, settings?: Record<string, unknown> }
 * Updates one integration config. Requires integrations.manage.
 */
export async function PATCH(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  if (
    !session.user.isSuperAdmin &&
    !session.user.permissionKeys.includes('integrations.manage')
  ) {
    return NextResponse.json({ error: 'Sin permiso para configurar' }, { status: 403 });
  }

  let body: { source?: string; isEnabled?: boolean; settings?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Cuerpo inválido' }, { status: 400 });
  }

  if (!body.source || typeof body.source !== 'string') {
    return NextResponse.json({ error: 'source es requerido' }, { status: 400 });
  }

  try {
    await updateIntegrationConfig(body.source as IntegrationSourceKey, {
      isEnabled: body.isEnabled,
      settings: body.settings,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('integration config PATCH error', error);
    return NextResponse.json({ error: 'Error al actualizar configuración' }, { status: 500 });
  }
}
