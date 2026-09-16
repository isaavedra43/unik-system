import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { AREA_LIST, areaViewPermissions, holdsAny } from '@/modules/areas/area-registry';
import {
  getPreferences,
  preferencesPatchSchema,
  updatePreferences,
} from '@/modules/copilot/preferences-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'assistant.use'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  return NextResponse.json({
    preferences: await getPreferences(session.user.id),
    // Operations surfaces this person can actually open (the panel only shows those).
    surfaces: {
      mywork: true,
      case: true,
      controlTower: hasPermission(session.user, 'operations.admin'),
      // At least one area workspace is open to this person (`/app/areas/<key>/trabajo`).
      area: AREA_LIST.some((area) => holdsAny(session.user, areaViewPermissions(area))),
    },
  });
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
  // Partial update; `surfaceModes: {[kind]: mode}` changes only the surfaces it names.
  const parsed = preferencesPatchSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Datos inválidos', details: parsed.error.issues },
      { status: 400 }
    );
  return NextResponse.json({ preferences: await updatePreferences(session.user.id, parsed.data) });
}
