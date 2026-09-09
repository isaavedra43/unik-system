import { requirePermission, hasPermission } from '@/modules/auth/authorization';
import { getPackagesWorkspace } from '@/modules/packages/packages-service';
import { getUserTablePreference } from '@/modules/sales/table-preferences-service';
import { listTableViews, getDefaultTableView } from '@/modules/sales/table-views-service';
import { getUnreadNotificationCount } from '@/modules/sales/notifications-service';
import { getWatchedEntityIds } from '@/modules/sales/entity-watch-service';
import { PACKAGES_TABLE_KEY, PACKAGE_COLUMNS } from '@/modules/packages/packages-columns';
import { packageQueryStateSchema, type TablePreferenceConfig } from '@/modules/packages/packages-filters';
import { PackagesWorkspace } from '@/components/packages/PackagesWorkspace';
import {
  getLatestPackagesSyncRun, getActivePackagesSyncRun, type SyncRunStatus,
} from '@/modules/integrations/zoho/packages-sync';
import { PACKAGE_ENTITY_TYPE } from '@/modules/packages/permissions';
import {
  saveTablePreferenceJson, resetTablePreferenceAction, createViewAction,
  watchAction, unwatchAction, bulkWatchAction, exportAction,
} from './actions';

export const runtime = 'nodejs';

interface SearchParams { search?: string; page?: string; page_size?: string; sort?: string; filters?: string; view?: string; }

export default async function PackagesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission('packages.view');
  const params = await searchParams;

  const defaultSort: { field: string; direction: 'asc' | 'desc' }[] = [{ field: 'packageNumber', direction: 'asc' }];
  let sort = defaultSort;
  if (params.sort) { try { const parsed = JSON.parse(params.sort); sort = Array.isArray(parsed) && parsed.length > 0 ? parsed : defaultSort; } catch { sort = defaultSort; } }

  let filters = { logic: 'AND' as const, rules: [] };
  if (params.filters) { try { filters = JSON.parse(params.filters); } catch { filters = { logic: 'AND', rules: [] }; } }

  const query = packageQueryStateSchema.parse({
    search: params.search ?? '', filters, sort,
    page: params.page ? Number(params.page) : 1,
    page_size: params.page_size ? Number(params.page_size) : 50,
  });

  const [result, preference, views, defaultView, unreadCount, activeSyncRun, latestSyncRun] = await Promise.all([
    getPackagesWorkspace(query),
    getUserTablePreference(user.id, PACKAGES_TABLE_KEY),
    listTableViews(user.id, PACKAGES_TABLE_KEY),
    getDefaultTableView(user.id, PACKAGES_TABLE_KEY),
    getUnreadNotificationCount(user.id),
    getActivePackagesSyncRun(),
    getLatestPackagesSyncRun(),
  ]);

  const watchedIds = await getWatchedEntityIds(user.id, PACKAGE_ENTITY_TYPE, result.data.map((p) => p.id));

  const canExport = hasPermission(user, 'packages.export');
  const canWatch = hasPermission(user, 'packages.watch');
  const canShareViews = hasPermission(user, 'packages.share_views');

  const defaultPreference: TablePreferenceConfig = {
    version: 1,
    columnOrder: PACKAGE_COLUMNS.sort((a, b) => a.priority - b.priority).map((c) => c.id),
    columnVisibility: Object.fromEntries(PACKAGE_COLUMNS.map((c) => [c.id, c.defaultVisible])),
    columnWidths: Object.fromEntries(PACKAGE_COLUMNS.map((c) => [c.id, c.defaultWidth])),
    columnPinning: { left: [], right: [] },
    density: 'normal', pageSize: 50,
  };

  return (
    <PackagesWorkspace
      user={user} tableKey={PACKAGES_TABLE_KEY} entityLabel="Paquete" entityLabelPlural="Paquetes"
      basePath="/app/packages" permissionView="packages.view" permissionExport="packages.export"
      permissionWatch="packages.watch" permissionShareViews="packages.share_views"
      initialData={result} initialQuery={query} preference={preference ?? defaultPreference}
      views={views} defaultViewId={defaultView?.id ?? null} watchedIds={watchedIds}
      unreadNotifications={unreadCount} canExport={canExport} canWatch={canWatch}
      canShareViews={canShareViews} initialSyncStatus={formatSyncStatus(latestSyncRun, activeSyncRun)}
      savePreferenceAction={saveTablePreferenceJson} resetPreferenceAction={resetTablePreferenceAction}
      createViewAction={createViewAction} watchAction={watchAction} unwatchAction={unwatchAction}
      bulkWatchAction={bulkWatchAction} exportAction={exportAction}
    />
  );
}

function formatSyncStatus(latestRun: SyncRunStatus | null, activeRun: SyncRunStatus | null) {
  return {
    active_run: activeRun ? {
      run_id: activeRun.runId, mode: activeRun.mode, status: activeRun.status,
      started_at: activeRun.startedAt.toISOString(), completed_at: activeRun.completedAt?.toISOString() ?? null,
    } : null,
    latest_run: latestRun ? {
      run_id: latestRun.runId, mode: latestRun.mode, status: latestRun.status,
      started_at: latestRun.startedAt.toISOString(), completed_at: latestRun.completedAt?.toISOString() ?? null,
      pages_scanned: latestRun.pagesScanned, records_seen: latestRun.recordsSeen,
      records_pending: latestRun.recordsPending, details_fetched: latestRun.detailsFetched,
      details_failed: latestRun.detailsFailed, error_code: latestRun.errorCode,
    } : null,
  };
}
