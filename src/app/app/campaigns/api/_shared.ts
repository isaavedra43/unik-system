import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getCurrentSession, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { CampaignError } from '@/modules/campaigns/campaign-service';

type Guard = { user: CurrentUser } | { response: NextResponse };

async function guard(check: (user: CurrentUser) => boolean, denied: string): Promise<Guard> {
  const session = await getCurrentSession();
  if (!session)
    return { response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  if (!check(session.user))
    return { response: NextResponse.json({ error: denied }, { status: 403 }) };
  return { user: session.user };
}

export const requireCampaignsViewer = () =>
  guard(
    (u) =>
      hasPermission(u, 'campaigns.view') ||
      hasPermission(u, 'campaigns.manage') ||
      hasPermission(u, 'campaigns.approve'),
    'Sin permiso para ver campañas'
  );
export const requireCampaignsManager = () =>
  guard((u) => hasPermission(u, 'campaigns.manage'), 'Sin permiso para gestionar campañas');
export const requireCampaignsApprover = () =>
  guard((u) => hasPermission(u, 'campaigns.approve'), 'Sin permiso para aprobar campañas');

export function campaignErrorResponse(err: unknown): NextResponse {
  if (err instanceof CampaignError)
    return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof ZodError) {
    return NextResponse.json({ error: 'Datos inválidos', details: err.issues }, { status: 400 });
  }
  if (err instanceof SyntaxError)
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  console.error('[campaigns-api]', err instanceof Error ? err.message : err);
  return NextResponse.json({ error: 'Error interno' }, { status: 500 });
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}
