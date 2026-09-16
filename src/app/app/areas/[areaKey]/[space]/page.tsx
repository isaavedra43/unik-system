import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { AreaSpecialView } from '@/components/areas/AreaSpecialView';
import { AreaCommsPage } from '@/components/areas/spaces/AreaCommsPage';
import { AreaDashboard } from '@/components/areas/spaces/AreaDashboard';
import { AreaWorkspace } from '@/components/areas/AreaWorkspace';
import { AreaWorkspaceShell } from '@/components/areas/AreaWorkspaceShell';
import { requireAnyPermission, type CurrentUser } from '@/modules/auth/authorization';
import {
  areaActPermissions,
  areaExportPermissions,
  areaViewPermissions,
  findAreaSpace,
  getArea,
  holdsAny,
  knownAreaPermissions,
  rowKindsForSpace,
  toAreaClientMeta,
  type AreaMeta,
  type AreaSpace,
} from '@/modules/areas/area-registry';
import { AREA_ROW_ENTITY_TYPE } from '@/modules/areas/area-work-row';
import { areaWorkBranches } from '@/modules/areas/area-server-registry';
import { ensureAreaRegistrations } from '@/modules/areas/register-all';
import {
  areaWorkColumnMap,
  areaWorkColumns,
  areaWorkDefaultColumnOrder,
} from '@/modules/areas/work-columns';
import { areaWorkQueryFromSearchParams, type AreaWorkScope } from '@/modules/areas/work-filters';
import { listAreaWorkRows } from '@/modules/areas/work-rows-service';
import { getUnreadNotificationCount } from '@/modules/sales/notifications-service';
import { getWatchedEntityIds } from '@/modules/sales/entity-watch-service';
import { getUserTablePreference } from '@/modules/sales/table-preferences-service';
import { getDefaultTableView, listTableViews } from '@/modules/sales/table-views-service';
import {
  bulkWatchAreaRowsAction,
  createAreaViewAction,
  exportAreaRowsAction,
  resetAreaPreferenceAction,
  saveAreaPreferenceAction,
  unwatchAreaRowAction,
  watchAreaRowAction,
} from '../actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One space of an area (plan 7.1): `dashboard`, `trabajo`, `comunicaciones`,
 * the specialized view of the area or one of its detail lists. Deep links are
 * stable and every space is a Server Component with its own loading and error
 * states.
 */

type SearchParams = Record<string, string | string[] | undefined>;

function flatten(params: SearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') out[key] = first;
  }
  return out;
}

async function workContent(
  area: AreaMeta,
  space: AreaSpace,
  user: CurrentUser,
  params: SearchParams,
  nowIso: string
): Promise<ReactNode> {
  const rowKinds = rowKindsForSpace(area, space);
  const available = areaWorkBranches(area).map((branch) => branch.rowKind);
  const offered = rowKinds.filter((kind) => available.includes(kind));
  const flat = flatten(params);
  const query = areaWorkQueryFromSearchParams(flat, area, {
    userId: user.id,
    rowKinds: offered,
  });

  const columns = areaWorkColumns(area);
  const [result, preference, views, defaultView, unread] = await Promise.all([
    listAreaWorkRows(user, area, query),
    getUserTablePreference(user.id, area.workCenter.tableKey),
    listTableViews(user.id, area.workCenter.tableKey),
    getDefaultTableView(user.id, area.workCenter.tableKey),
    getUnreadNotificationCount(user.id),
  ]);
  const watchedIds = await getWatchedEntityIds(
    user.id,
    AREA_ROW_ENTITY_TYPE,
    result.data.map((row) => row.id)
  );

  const defaultPreference = {
    version: 1 as const,
    columnOrder: areaWorkDefaultColumnOrder(area),
    columnVisibility: Object.fromEntries(
      columns.map((column) => [column.id, column.defaultVisible])
    ),
    columnWidths: Object.fromEntries(columns.map((column) => [column.id, column.defaultWidth])),
    columnPinning: { left: [], right: [] },
    density: 'normal' as const,
    pageSize: query.page_size,
  };

  const canAct = holdsAny(user, areaActPermissions(area));
  // Exporting has its own key (plan 6.1): the button only appears for whoever
  // holds it, and `exportAreaRowsAction` checks it again on the server.
  const exportPermissions = areaExportPermissions(area);
  const basePath = `/app/areas/${area.key}/${space.slug}`;

  return (
    <AreaWorkspace
      user={user}
      area={toAreaClientMeta(area)}
      spaceSlug={space.slug}
      basePath={basePath}
      rowKinds={space.kind === 'subpage' ? [] : offered}
      initialData={result}
      areaQuery={query}
      chipState={{
        kind: flat.kind && flat.kind !== 'all' ? flat.kind : null,
        scope: (flat.scope as AreaWorkScope) ?? 'open',
        mine: flat.mios === '1',
        overdue: flat.vencidos === '1',
      }}
      preference={preference ?? defaultPreference}
      views={views}
      defaultViewId={defaultView?.id ?? null}
      watchedIds={[...watchedIds]}
      unreadNotifications={unread}
      canExport={holdsAny(user, exportPermissions)}
      exportPermissions={exportPermissions}
      canWatch
      canShareViews={canAct}
      canUseAssistant={holdsAny(user, ['assistant.use'])}
      actPermissions={areaActPermissions(area)}
      columns={columns}
      columnMap={areaWorkColumnMap(area)}
      defaultColumnOrder={areaWorkDefaultColumnOrder(area)}
      savePreferenceAction={saveAreaPreferenceAction.bind(null, area.key)}
      resetPreferenceAction={resetAreaPreferenceAction.bind(null, area.key)}
      createViewAction={createAreaViewAction.bind(null, area.key)}
      watchAction={watchAreaRowAction.bind(null, area.key)}
      unwatchAction={unwatchAreaRowAction.bind(null, area.key)}
      bulkWatchAction={bulkWatchAreaRowsAction.bind(null, area.key)}
      exportAction={exportAreaRowsAction.bind(null, area.key)}
      nowIso={nowIso}
    />
  );
}

export default async function AreaSpacePage({
  params,
  searchParams,
}: {
  params: Promise<{ areaKey: string; space: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { areaKey, space: spaceSlug } = await params;
  const area = getArea(areaKey);
  if (!area) notFound();

  const user = await requireAnyPermission(areaViewPermissions(area));
  const space = findAreaSpace(area, spaceSlug);
  if (!space) notFound();
  if (!holdsAny(user, knownAreaPermissions([...space.permissions, 'operations.admin']))) {
    notFound();
  }
  await ensureAreaRegistrations();

  const searchParamsValue = await searchParams;
  const nowIso = new Date().toISOString();

  let content: ReactNode;
  if (space.kind === 'dashboard') {
    content = <AreaDashboard area={area} user={user} nowIso={nowIso} />;
  } else if (space.kind === 'comms') {
    content = (
      <AreaCommsPage
        area={area}
        user={user}
        nowIso={nowIso}
        searchParams={flatten(searchParamsValue)}
      />
    );
  } else if (space.kind === 'special') {
    content = (
      <AreaSpecialView
        areaKey={area.key}
        slug={space.slug}
        label={space.label}
        areaLabel={area.label}
        description={space.description}
        user={{ id: user.id, name: user.name }}
        canAct={holdsAny(user, areaActPermissions(area))}
        params={flatten(searchParamsValue)}
      />
    );
  } else {
    content = await workContent(area, space, user, searchParamsValue, nowIso);
  }

  return (
    <AreaWorkspaceShell area={area} user={user} activeSlug={space.slug}>
      {/* El centro de trabajo y las comunicaciones ocupan todo el alto: sin la rejilla del espacio. */}
      <div className={space.kind === 'work' || space.kind === 'comms' ? undefined : 'area-space'}>
        {space.kind === 'subpage' || space.kind === 'special' ? (
          <p className="area-space-description">{space.description}</p>
        ) : null}
        {content}
      </div>
    </AreaWorkspaceShell>
  );
}
