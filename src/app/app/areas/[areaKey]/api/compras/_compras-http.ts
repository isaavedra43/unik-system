import { NextResponse } from 'next/server';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { AreaMeta } from '@/modules/areas/area-registry';
import { resolveAreaRoute } from '../../_area-http';

/**
 * Guard of the Compras read APIs (`/app/areas/compras/api/compras/...`).
 *
 * It is the shared area guard (signed in + a view permission of the area, or
 * `operations.admin`) plus one more rule: these endpoints only answer under the
 * Compras area, so `/app/areas/logistica/api/compras/...` is a 404 instead of a
 * back door into another area's URL space.
 *
 * The purchases queries themselves check the purchases permissions again, so a
 * person who can open the area but not Compras gets a 403 from the service.
 */

export type ComprasRouteContext =
  { ok: true; user: CurrentUser; area: AreaMeta } | { ok: false; response: NextResponse };

const COMPRAS = 'compras';

export async function resolveComprasRoute(areaKeyParam: string): Promise<ComprasRouteContext> {
  const context = await resolveAreaRoute(areaKeyParam);
  if (!context.ok) return context;
  if (context.area.key !== COMPRAS) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Ruta desconocida' }, { status: 404 }),
    };
  }
  return context;
}

/** `page` / `pageSize` of a list endpoint, bounded like every other UNIK list. */
export function readPage(search: URLSearchParams): { page: number; pageSize: number } {
  const page = Number.parseInt(search.get('page') ?? '1', 10);
  const pageSize = Number.parseInt(search.get('pageSize') ?? '24', 10);
  return {
    page: Number.isFinite(page) ? Math.min(Math.max(page, 1), 10_000) : 1,
    pageSize: Number.isFinite(pageSize) ? Math.min(Math.max(pageSize, 1), 100) : 24,
  };
}

/** Trimmed query string parameter, or null when it is empty. */
export function readText(search: URLSearchParams, key: string, max = 200): string | null {
  const value = search.get(key);
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, max);
  return text.length > 0 ? text : null;
}
