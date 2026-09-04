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
import { prisma } from '@/lib/prisma';
import {
  ENTITY_TYPE,
  SOURCE,
  SYNC_STATUS,
} from '@/modules/integrations/zoho/sales-orders-sync';
import { SalesOrdersWorkspace } from '@/components/sales/SalesOrdersWorkspace';

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
  const [result, preference, views, defaultView, unreadCount, lastZohoSync] =
    await Promise.all([
      getSalesOrdersWorkspace(query),
      getUserTablePreference(user.id, SALES_ORDERS_TABLE_KEY),
      listTableViews(user.id, SALES_ORDERS_TABLE_KEY),
      getDefaultTableView(user.id, SALES_ORDERS_TABLE_KEY),
      getUnreadNotificationCount(user.id),
      prisma.integrationSyncRun.findFirst({
        where: {
          source: SOURCE,
          entityType: ENTITY_TYPE,
          mode: 'sync',
          status: SYNC_STATUS.COMPLETED,
        },
        orderBy: { completedAt: 'desc' },
        select: { completedAt: true },
      }),
    ]);

  const lastZohoSyncAt = lastZohoSync?.completedAt
    ? lastZohoSync.completedAt.toISOString()
    : null;

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
      lastZohoSyncAt={lastZohoSyncAt}
    />
  );
}
