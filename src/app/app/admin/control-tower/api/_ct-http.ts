import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getCurrentSession, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { isOperationsError } from '@/modules/operations/errors';
import { CONTROL_TOWER_PERMISSION } from '@/modules/control-tower/control-tower-service';

/**
 * Guarda compartida de la API de la Torre de Control
 * (`/app/admin/control-tower/api/...`).
 *
 * TODA ruta de este árbol exige sesión + `operations.admin` (plan 7.7). Los
 * servicios vuelven a comprobarlo con `assertControlTowerAccess`, así que una
 * ruta nueva que olvide este guarda sigue sin devolver datos; esto sólo evita
 * pagar la consulta y da el 401/403 correcto.
 */

export type ControlTowerRouteContext =
  { ok: true; user: CurrentUser } | { ok: false; response: NextResponse };

export async function resolveControlTowerRoute(): Promise<ControlTowerRouteContext> {
  const session = await getCurrentSession();
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  }
  if (!hasPermission(session.user, CONTROL_TOWER_PERMISSION)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Necesitas permiso de administrar operaciones' },
        { status: 403 }
      ),
    };
  }
  return { ok: true, user: session.user };
}

/** Cuerpo JSON de un POST, o la respuesta 400 ya lista. */
export async function readJsonBody(
  request: Request
): Promise<{ ok: true; value: unknown } | { ok: false; response: NextResponse }> {
  try {
    const value = await request.json();
    return { ok: true, value };
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) };
  }
}

/** Fecha de un parámetro de consulta; `null` cuando falta o no es válida. */
export function dateParam(params: URLSearchParams, key: string): Date | null {
  const raw = params.get(key);
  if (!raw) return null;
  const parsed = new Date(raw.length <= 10 ? `${raw}T00:00:00.000Z` : raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Entero acotado de un parámetro de consulta. */
export function intParam(
  params: URLSearchParams,
  key: string,
  bounds: { min: number; max: number }
): number | null {
  const raw = params.get(key);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed, bounds.min), bounds.max);
}

/** Lista separada por comas (`?kind=a,b`), acotada y sin vacíos. */
export function listParam(params: URLSearchParams, key: string, max = 20): string[] {
  const values = params.getAll(key).flatMap((value) => value.split(','));
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

/** Traduce un error de dominio o de validación a su respuesta, en español. */
export function controlTowerErrorResponse(error: unknown): NextResponse {
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: error.issues[0]?.message ?? 'Datos inválidos', code: 'invalid_request' },
      { status: 422 }
    );
  }
  if (isOperationsError(error)) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.httpStatus }
    );
  }
  console.error(
    JSON.stringify({
      component: 'control-tower-api',
      event: 'unexpected_error',
      message: error instanceof Error ? error.message : String(error),
    })
  );
  return NextResponse.json({ error: 'No pudimos completar la consulta' }, { status: 500 });
}
