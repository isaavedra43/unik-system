import { NextResponse } from 'next/server';
import type { CurrentUser } from '@/modules/auth/authorization';
import { CONTABILIDAD_AREA_KEY } from '@/modules/areas/contabilidad/contabilidad-model';
import { resolveAreaRoute } from '../../_area-http';

/**
 * Guard of the Contabilidad read APIs. On top of the area gate
 * (`resolveAreaRoute`: signed in + `finance.view` or `operations.admin`), the
 * route only answers for the Contabilidad area: these paths live next to the
 * `[space]` segment, so any other area key is a 404.
 *
 * The finance services check the finer permission again (a person with only
 * `finance.capture_expense` sees their own expenses and nothing else).
 */
export type ContabilidadRoute =
  { ok: true; user: CurrentUser } | { ok: false; response: NextResponse };

export async function resolveContabilidadRoute(areaKeyParam: string): Promise<ContabilidadRoute> {
  if (areaKeyParam !== CONTABILIDAD_AREA_KEY) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Ruta de Contabilidad' }, { status: 404 }),
    };
  }
  const context = await resolveAreaRoute(areaKeyParam);
  if (!context.ok) return { ok: false, response: context.response };
  return { ok: true, user: context.user };
}

/** First value of a search param, trimmed; undefined when empty. */
export function param(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : undefined;
}

export function pageParam(url: URL, name = 'pagina'): number | undefined {
  const raw = param(url, name);
  if (!raw) return undefined;
  const page = Number.parseInt(raw, 10);
  return Number.isFinite(page) && page > 0 ? Math.min(page, 10_000) : undefined;
}
