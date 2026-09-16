// Hoja del panel del área (sólo tokens). Next permite CSS global desde un componente.
import '@/styles/operations/area-dashboard.css';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { AreaMeta } from '@/modules/areas/area-registry';
import { getAreaDashboard } from '@/modules/areas/dashboard-service';
import { AreaDashboardClient } from './AreaDashboardClient';

export interface AreaDashboardProps {
  area: AreaMeta;
  user: CurrentUser;
  /** Server time of the render, so the freshness label matches on hydration. */
  nowIso: string;
}

/**
 * Dashboard space of an area (plan 7.3). Server Component: it reads the cached
 * panel (`DashboardSnapshot`), recomputing it when the snapshot is missing or
 * older than the refresh cadence, and always with the live tiles recomputed for
 * this request.
 *
 * The access rule is the area one (`assertAreaAccess` inside the service): the
 * snapshot is area-wide, so it is never shown to somebody who may not open the
 * area, and it never carries anything personal.
 */
export async function AreaDashboard({ area, user, nowIso }: AreaDashboardProps) {
  const view = await getAreaDashboard(user, area, { now: new Date(nowIso) });

  return (
    <AreaDashboardClient
      areaKey={area.key}
      areaLabel={area.label}
      payload={view.payload}
      note={view.note}
      liveAt={view.liveAt}
      nowIso={nowIso}
    />
  );
}
