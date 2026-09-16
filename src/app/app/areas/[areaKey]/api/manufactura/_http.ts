import { NextResponse } from 'next/server';
import { AuthorizationError, type CurrentUser } from '@/modules/auth/authorization';
import type { AreaMeta } from '@/modules/areas/area-registry';
import { areaErrorResponse, resolveAreaRoute } from '../../_area-http';

/**
 * Guard of the Manufactura read APIs (`/app/areas/manufactura/api/manufactura/…`).
 *
 * On top of the shared area guard (signed in + the area's view permission or
 * `operations.admin`) it pins the route to Manufactura, so the same path under
 * another area key answers 404 instead of leaking a manufacturing read.
 *
 * The services check `manufacturing.view` again: somebody who opens the area
 * through `operations.admin` alone gets a clear 403, never an empty board.
 */

export const MANUFACTURA_AREA_KEY = 'manufactura';

export type ManufacturaRouteContext =
  { ok: true; user: CurrentUser; area: AreaMeta } | { ok: false; response: NextResponse };

export async function resolveManufacturaRoute(
  areaKeyParam: string
): Promise<ManufacturaRouteContext> {
  const context = await resolveAreaRoute(areaKeyParam);
  if (!context.ok) return context;
  if (context.area.key !== MANUFACTURA_AREA_KEY) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Ruta no disponible en esta área' }, { status: 404 }),
    };
  }
  return context;
}

/** Maps the error of a manufacturing read; a missing permission is a 403, not a 500. */
export function manufacturaErrorResponse(error: unknown): NextResponse {
  if (error instanceof AuthorizationError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  return areaErrorResponse(error);
}

/** Positive integer of a search param, inside `[min, max]`. */
export function intParam(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
