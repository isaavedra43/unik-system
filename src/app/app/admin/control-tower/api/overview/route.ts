import { NextResponse } from 'next/server';
import {
  DASHBOARD_SCOPE_CONTROL_TOWER,
  readDashboardSnapshot,
} from '@/modules/areas/dashboard-service';
import {
  CONTROL_TOWER_SCOPE_KEY,
  getControlTowerOverview,
  type ControlTowerOverview,
} from '@/modules/control-tower/control-tower-service';
import { controlTowerErrorResponse, resolveControlTowerRoute } from '../_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Un snapshot más viejo que esto ya no sirve para abrir la pantalla. */
const SNAPSHOT_TTL_MS = 5 * 60_000;

/**
 * Resumen de la Torre de Control (plan 7.7 `resumen`).
 *
 * `GET` responde con la foto guardada (`DashboardSnapshot('control_tower')`)
 * cuando tiene menos de cinco minutos, y si no la calcula en vivo: la primera
 * visita del día nunca espera el cálculo completo si el job ya corrió.
 * `GET ?fresh=1` fuerza el cálculo en vivo ("Actualizar").
 */
export async function GET(request: Request) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  const now = new Date();
  const fresh = new URL(request.url).searchParams.get('fresh') === '1';
  try {
    if (!fresh) {
      const snapshot = await readDashboardSnapshot(
        DASHBOARD_SCOPE_CONTROL_TOWER,
        CONTROL_TOWER_SCOPE_KEY
      );
      const age = snapshot
        ? now.getTime() - snapshot.computedAt.getTime()
        : Number.POSITIVE_INFINITY;
      if (snapshot && age < SNAPSHOT_TTL_MS) {
        return NextResponse.json({
          overview: snapshot.payload as unknown as ControlTowerOverview,
          source: 'snapshot',
          computedAt: snapshot.computedAt.toISOString(),
        });
      }
    }
    const overview = await getControlTowerOverview(context.user, { now });
    return NextResponse.json({ overview, source: 'live', computedAt: overview.computedAt });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}
