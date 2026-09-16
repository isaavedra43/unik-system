import { NextResponse } from 'next/server';
import {
  getCurrentSession,
  hasAnyPermission,
  type CurrentUser,
} from '@/modules/auth/authorization';
import { areaViewPermissions, getArea, type AreaMeta } from '@/modules/areas/area-registry';
import { AreaWorkQueryError } from '@/modules/areas/work-filters';
import { isOperationsError } from '@/modules/operations/errors';
import { ensureAreaRegistrations } from '@/modules/areas/register-all';

/**
 * Shared guard of the area API routes (`/app/areas/[areaKey]/api/...`).
 *
 * Signed-in + the area's own view permission (or `operations.admin`). The
 * services check the finer area rule again (`canViewArea`), and the case rule
 * applies on top for anything that belongs to a case.
 */

export type AreaRouteContext =
  { ok: true; user: CurrentUser; area: AreaMeta } | { ok: false; response: NextResponse };

export async function resolveAreaRoute(areaKeyParam: string): Promise<AreaRouteContext> {
  const session = await getCurrentSession();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }),
    };
  }
  const area = getArea(areaKeyParam);
  if (!area) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Área desconocida' }, { status: 404 }),
    };
  }
  if (!hasAnyPermission(session.user, areaViewPermissions(area))) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Sin permiso' }, { status: 403 }),
    };
  }
  await ensureAreaRegistrations();
  return { ok: true, user: session.user, area };
}

/** Body of a POST, or a 400 response. */
export async function readJson(
  request: Request
): Promise<{ ok: true; value: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) };
  }
}

/** Maps a query or domain error to its HTTP answer, in Spanish. */
export function areaErrorResponse(error: unknown): NextResponse {
  if (error instanceof AreaWorkQueryError) {
    return NextResponse.json({ error: error.message }, { status: 422 });
  }
  if (isOperationsError(error)) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.httpStatus }
    );
  }
  console.error(
    JSON.stringify({
      component: 'areas-api',
      event: 'unexpected_error',
      message: error instanceof Error ? error.message : String(error),
    })
  );
  return NextResponse.json({ error: 'No pudimos completar la consulta' }, { status: 500 });
}
