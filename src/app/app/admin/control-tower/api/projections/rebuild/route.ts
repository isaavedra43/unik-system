import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  PROJECTION_KEYS,
  getProjectionStatus,
  rebuildProjections,
  type ProjectionKey,
} from '@/modules/control-tower/projections-service';
import { enqueueProjectionsRefresh } from '@/modules/control-tower/control-tower-jobs';
import { controlTowerErrorResponse, readJsonBody, resolveControlTowerRoute } from '../../_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Una reconstrucción síncrona puede tardar: el job tiene 10 minutos, esta ruta 5. */
export const maxDuration = 300;

/**
 * Recálculo de las proyecciones de inteligencia de procesos (plan 7.9).
 *
 * `GET` dice qué tan frescas están las cuatro proyecciones.
 * `POST` las reconstruye:
 * - por omisión ENCOLA `ct.projections_refresh` (deduplicado: diez clics son una
 *   corrida) y responde de inmediato;
 * - con `{ wait: true }` corre en línea y devuelve el resultado por proyección,
 *   que es lo que hace falta para ver el error cuando algo no cuadra.
 */
const bodySchema = z.object({
  full: z.boolean().default(true),
  wait: z.boolean().default(false),
  keys: z.array(z.enum(PROJECTION_KEYS)).max(PROJECTION_KEYS.length).optional(),
});

export async function GET() {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  try {
    const projections = await getProjectionStatus(context.user, { now: new Date() });
    return NextResponse.json({ projections });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  try {
    const input = bodySchema.parse(body.value ?? {});
    const keys = (input.keys ?? []) as ProjectionKey[];
    if (input.wait) {
      const result = await rebuildProjections(context.user, {
        full: input.full,
        ...(keys.length > 0 ? { keys } : {}),
        now: new Date(),
      });
      return NextResponse.json({ mode: 'inline', result });
    }
    const job = await enqueueProjectionsRefresh({
      full: input.full,
      ...(keys.length > 0 ? { keys } : {}),
      requestedByUserId: context.user.id,
    });
    return NextResponse.json({ mode: 'queued', job }, { status: 202 });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}
