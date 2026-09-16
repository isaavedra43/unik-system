import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  APPLY_CASE_LIMIT,
  applyToOpenCases,
  simulateBlueprint,
  simulateCaseById,
} from '@/modules/control-tower/simulation';
import { controlTowerErrorResponse, readJsonBody, resolveControlTowerRoute } from '../_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Simulación "qué pasaría si" (plan 7.8e): pase hacia adelante tipo CPM sobre
 * `dependsOn` con las duraciones medidas por paso (p50 activo + p50 espera) y,
 * cuando un paso aún no tiene historia, su SLA.
 *
 * - `{ caseId }` simula ESE expediente;
 * - sin `caseId` simula una venta nueva sobre el blueprint;
 * - `{ apply: true }` aplica el escenario a los expedientes abiertos con fecha
 *   prometida (≤ 500) y lista los que incumplirían.
 *
 * Nada se escribe: la simulación es una lectura.
 */
const bodySchema = z.object({
  caseId: z.string().trim().min(1).max(60).optional(),
  apply: z.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(APPLY_CASE_LIMIT).optional(),
  scenario: z
    .object({
      delays: z
        .array(
          z.object({
            stepKey: z.string().trim().min(1).max(80),
            minutes: z.coerce.number().min(0).max(43_200),
          })
        )
        .max(50)
        .optional(),
      capacity: z
        .array(
          z.object({
            areaKey: z.string().trim().min(1).max(40),
            factor: z.coerce.number().min(0.1).max(10),
          })
        )
        .max(20)
        .optional(),
    })
    .default({}),
});

export async function POST(request: Request) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  try {
    const input = bodySchema.parse(body.value ?? {});
    const now = new Date();
    if (input.apply) {
      const result = await applyToOpenCases(context.user, {
        scenario: input.scenario,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        now,
      });
      return NextResponse.json({ apply: result });
    }
    const simulation = input.caseId
      ? await simulateCaseById(context.user, {
          caseId: input.caseId,
          scenario: input.scenario,
          now,
        })
      : await simulateBlueprint(context.user, { scenario: input.scenario, now });
    return NextResponse.json({ simulation });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}
