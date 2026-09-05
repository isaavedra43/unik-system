import { requirePermission, hasPermission } from '@/modules/auth/authorization';
import { getSalesOrdersWorkspace } from '@/modules/sales/sales-orders-service';
import { getUserTablePreference } from '@/modules/sales/table-preferences-service';
import { listTableViews, getDefaultTableView } from '@/modules/sales/table-views-service';
import { getUnreadNotificationCount } from '@/modules/sales/notifications-service';
import { getWatchedEntityIds } from '@/modules/sales/entity-watch-service';
import { SALES_ORDERS_TABLE_KEY, SALES_ORDER_COLUMNS } from '@/modules/sales/sales-orders-columns';
import {
  salesOrderQueryStateSchema,
  TablePreferenceConfig,
} from '@/modules/sales/sales-orders-filters';
import { SalesOrdersWorkspace } from '@/components/sales/SalesOrdersWorkspace';
import {
  getLatestSyncRun,
  getActiveSyncRun,
  SyncRunStatus,
} from '@/modules/integrations/zoho/sales-orders-sync';

export const runtime = 'nodejs';

interface SearchParams {
  search?: string;
  page?: string;
  page_size?: string;
  sort?: string;
  filters?: string;
  view?: string;
}

export default async function SalesOrdersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePermission('sales_orders.view');
  const params = await searchParams;

  // Build query state from URL params
  let sort: { field: string; direction: 'asc' | 'desc' }[] = [];
  if (params.sort) {
    try {
      sort = JSON.parse(params.sort);
    } catch {
      sort = [];
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

  const query = salesOrderQueryStateSchema.parse(queryInput);

  // Load data server-side
  const [result, preference, views, defaultView, unreadCount, activeSyncRun, latestSyncRun] =
    await Promise.all([
      getSalesOrdersWorkspace(query),
      getUserTablePreference(user.id, SALES_ORDERS_TABLE_KEY),
      listTableViews(user.id, SALES_ORDERS_TABLE_KEY),
      getDefaultTableView(user.id, SALES_ORDERS_TABLE_KEY),
      getUnreadNotificationCount(user.id),
      getActiveSyncRun(),
      getLatestSyncRun(),
    ]);

  // Get watched entity IDs for the current page
  const watchedIds = await getWatchedEntityIds(
    user.id,
    'sales_order',
    result.data.map((o) => o.id)
  );

  const canExport = hasPermission(user, 'sales_orders.export');
  const canWatch = hasPermission(user, 'sales_orders.watch');
  const canShareViews = hasPermission(user, 'sales_orders.share_views');

  const defaultPreference: TablePreferenceConfig = {
    version: 1,
    columnOrder: SALES_ORDER_COLUMNS.sort((a, b) => a.priority - b.priority).map((c) => c.id),
    columnVisibility: Object.fromEntries(SALES_ORDER_COLUMNS.map((c) => [c.id, c.defaultVisible])),
    columnWidths: Object.fromEntries(SALES_ORDER_COLUMNS.map((c) => [c.id, c.defaultWidth])),
    columnPinning: { left: [], right: [] },
    density: 'normal',
    pageSize: 50,
  };

  return (
    <SalesOrdersWorkspace
      user={user}
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
