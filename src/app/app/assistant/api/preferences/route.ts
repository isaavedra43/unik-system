import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import {
  getPreferences,
  preferencesSchema,
  updatePreferences,
} from '@/modules/copilot/preferences-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  return NextResponse.json({ preferences: await getPreferences(session.user.id) });
}

export async function PATCH(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = preferencesSchema.partial().safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Datos inválidos', details: parsed.error.issues },
      { status: 400 }
    );
  return NextResponse.json({ preferences: await updatePreferences(session.user.id, parsed.data) });
}
