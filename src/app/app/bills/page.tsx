import { requirePermission, hasPermission } from '@/modules/auth/authorization';
import { getBillsWorkspace } from '@/modules/bills/bills-service';
import { getUserTablePreference } from '@/modules/sales/table-preferences-service';
import { listTableViews, getDefaultTableView } from '@/modules/sales/table-views-service';
import { getUnreadNotificationCount } from '@/modules/sales/notifications-service';
import { getWatchedEntityIds } from '@/modules/sales/entity-watch-service';
import { BILLS_TABLE_KEY, BILL_COLUMNS } from '@/modules/bills/bills-columns';
import {
  billQueryStateSchema,
  type BillQueryState,
} from '@/modules/bills/bills-filters';
import type { TablePreferenceConfig } from '@/modules/shared/entity-workspace-types';
import { BillsWorkspace } from '@/components/bills/BillsWorkspace';
import {
  getLatestBillsSyncRun,
  getActiveBillsSyncRun,
  type SyncRunStatus,
} from '@/modules/integrations/zoho/bills-sync';
import { BILL_ENTITY_TYPE } from '@/modules/bills/permissions';
import {
  saveTablePreferenceJson,
  resetTablePreferenceAction,
  createViewAction,
  watchAction,
  unwatchAction,
  bulkWatchAction,
  exportAction,
} from './actions';

export const runtime = 'nodejs';

interface SearchParams {
  search?: string;
  page?: string;
  page_size?: string;
  sort?: string;
  filters?: string;
  view?: string;
}

export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePermission('bills.view');
  const params = await searchParams;

  const defaultSort: { field: string; direction: 'asc' | 'desc' }[] = [
    { field: 'date', direction: 'desc' },
  ];
  let sort = defaultSort;
  if (params.sort) {
    try {
      const parsed = JSON.parse(params.sort);
      sort = Array.isArray(parsed) && parsed.length > 0 ? parsed : defaultSort;
    } catch {
      sort = defaultSort;
    }
  }

  let filters = { logic: 'AND' as const, rules: [] };
  if (params.filters) {
    try {
      filters = JSON.parse(params.filters);
    } catch {
      filters = { logic: 'AND', rules: [] };
    }
  }

  const queryInput = {
    search: params.search ?? '',
    filters,
    sort,
    page: params.page ? Number(params.page) : 1,
    page_size: params.page_size ? Number(params.page_size) : 50,
  };

  const query: BillQueryState = billQueryStateSchema.parse(queryInput);

  const [result, preference, views, defaultView, unreadCount, activeSyncRun, latestSyncRun] =
    await Promise.all([
      getBillsWorkspace(query),
      getUserTablePreference(user.id, BILLS_TABLE_KEY),
      listTableViews(user.id, BILLS_TABLE_KEY),
      getDefaultTableView(user.id, BILLS_TABLE_KEY),
      getUnreadNotificationCount(user.id),
      getActiveBillsSyncRun(),
      getLatestBillsSyncRun(),
    ]);

  const watchedIds = await getWatchedEntityIds(
    user.id,
    BILL_ENTITY_TYPE,
    result.data.map((b) => b.id)
  );

  const canExport = hasPermission(user, 'bills.export');
  const canWatch = hasPermission(user, 'bills.watch');
  // Bills module does not define a share_views permission; shared views are
  // disabled in the UI. (The shared table-views service still enforces
  // sales_orders.share_views server-side as defense in depth.)
  const canShareViews = false;

  const defaultPreference: TablePreferenceConfig = {
    version: 1,
    columnOrder: [...BILL_COLUMNS].sort((a, b) => a.priority - b.priority).map((c) => c.id),
    columnVisibility: Object.fromEntries(BILL_COLUMNS.map((c) => [c.id, c.defaultVisible])),
    columnWidths: Object.fromEntries(BILL_COLUMNS.map((c) => [c.id, c.defaultWidth])),
    columnPinning: { left: [], right: [] },
    density: 'normal',
    pageSize: 50,
  };

  return (
    <BillsWorkspace
      user={user}
      tableKey={BILLS_TABLE_KEY}
      entityLabel="Factura de compra"
      entityLabelPlural="Facturas de compra"
      basePath="/app/bills"
      permissionView="bills.view"
      permissionExport="bills.export"
      permissionWatch="bills.watch"
      permissionShareViews="bills.share_views"
      initialData={result}
      initialQuery={query}
      preference={preference ?? defaultPreference}
      views={views}
      defaultViewId={defaultView?.id ?? null}
      watchedIds={watchedIds}
      unreadNotifications={unreadCount}
      canExport={canExport}
      canWatch={canWatch}
      canShareViews={canShareViews}
      initialSyncStatus={formatSyncStatus(latestSyncRun, activeSyncRun)}
      savePreferenceAction={saveTablePreferenceJson}
      resetPreferenceAction={resetTablePreferenceAction}
      createViewAction={createViewAction}
      watchAction={watchAction}
      unwatchAction={unwatchAction}
      bulkWatchAction={bulkWatchAction}
      exportAction={exportAction}
    />
  );
}

function formatSyncStatus(latestRun: SyncRunStatus | null, activeRun: SyncRunStatus | null) {
  return {
    active_run: activeRun
      ? {
          run_id: activeRun.runId,
          mode: activeRun.mode,
          status: activeRun.status,
          started_at: activeRun.startedAt.toISOString(),
          completed_at: activeRun.completedAt?.toISOString() ?? null,
        }
      : null,
    latest_run: latestRun
      ? {
          run_id: latestRun.runId,
          mode: latestRun.mode,
          status: latestRun.status,
          started_at: latestRun.startedAt.toISOString(),
          completed_at: latestRun.completedAt?.toISOString() ?? null,
          pages_scanned: latestRun.pagesScanned,
          records_seen: latestRun.recordsSeen,
          records_pending: latestRun.recordsPending,
          details_fetched: latestRun.detailsFetched,
          details_failed: latestRun.detailsFailed,
          error_code: latestRun.errorCode,
        }
      : null,
  };
}
