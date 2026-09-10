import { requirePermission, hasPermission } from '@/modules/auth/authorization';
import { getPurchaseOrdersWorkspace } from '@/modules/purchase-orders/purchase-orders-service';
import { getUserTablePreference } from '@/modules/sales/table-preferences-service';
import { listTableViews, getDefaultTableView } from '@/modules/sales/table-views-service';
import { getUnreadNotificationCount } from '@/modules/sales/notifications-service';
import { getWatchedEntityIds } from '@/modules/sales/entity-watch-service';
import {
  PURCHASE_ORDERS_TABLE_KEY,
  PURCHASE_ORDER_COLUMNS,
} from '@/modules/purchase-orders/purchase-orders-columns';
import {
  purchaseOrderQueryStateSchema,
  type TablePreferenceConfig,
} from '@/modules/purchase-orders/purchase-orders-filters';
import { PurchaseOrdersWorkspace } from '@/components/purchase-orders/PurchaseOrdersWorkspace';
import {
  getLatestPurchaseOrdersSyncRun,
  getActivePurchaseOrdersSyncRun,
  type SyncRunStatus,
} from '@/modules/integrations/zoho/purchase-orders-sync';
import { PURCHASE_ORDER_ENTITY_TYPE } from '@/modules/purchase-orders/permissions';
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

export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePermission('purchase_orders.view');
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

  const query = purchaseOrderQueryStateSchema.parse(queryInput);

  const [result, preference, views, defaultView, unreadCount, activeSyncRun, latestSyncRun] =
    await Promise.all([
      getPurchaseOrdersWorkspace(query),
      getUserTablePreference(user.id, PURCHASE_ORDERS_TABLE_KEY),
      listTableViews(user.id, PURCHASE_ORDERS_TABLE_KEY),
      getDefaultTableView(user.id, PURCHASE_ORDERS_TABLE_KEY),
      getUnreadNotificationCount(user.id),
      getActivePurchaseOrdersSyncRun(),
      getLatestPurchaseOrdersSyncRun(),
    ]);

  const watchedIds = await getWatchedEntityIds(
    user.id,
    PURCHASE_ORDER_ENTITY_TYPE,
    result.data.map((p) => p.id)
  );

  const canExport = hasPermission(user, 'purchase_orders.export');
  const canWatch = hasPermission(user, 'purchase_orders.watch');
  const canShareViews = hasPermission(user, 'purchase_orders.share_views');

  const defaultPreference: TablePreferenceConfig = {
    version: 1,
    columnOrder: [...PURCHASE_ORDER_COLUMNS]
      .sort((a, b) => a.priority - b.priority)
      .map((c) => c.id),
    columnVisibility: Object.fromEntries(
      PURCHASE_ORDER_COLUMNS.map((c) => [c.id, c.defaultVisible])
    ),
    columnWidths: Object.fromEntries(
      PURCHASE_ORDER_COLUMNS.map((c) => [c.id, c.defaultWidth])
    ),
    columnPinning: { left: [], right: [] },
    density: 'normal',
    pageSize: 50,
  };

  return (
    <PurchaseOrdersWorkspace
      user={user}
      tableKey={PURCHASE_ORDERS_TABLE_KEY}
      entityLabel="Orden de Compra"
      entityLabelPlural="Órdenes de Compra"
      basePath="/app/purchase-orders"
      permissionView="purchase_orders.view"
      permissionExport="purchase_orders.export"
      permissionWatch="purchase_orders.watch"
      permissionShareViews="purchase_orders.share_views"
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
