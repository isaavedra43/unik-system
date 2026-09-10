import { requirePermission, hasPermission } from '@/modules/auth/authorization';
import { getPaymentsWorkspace } from '@/modules/payments/payments-service';
import { getUserTablePreference } from '@/modules/sales/table-preferences-service';
import { listTableViews, getDefaultTableView } from '@/modules/sales/table-views-service';
import { getUnreadNotificationCount } from '@/modules/sales/notifications-service';
import { getWatchedEntityIds } from '@/modules/sales/entity-watch-service';
import { PAYMENTS_TABLE_KEY, PAYMENT_COLUMNS } from '@/modules/payments/payments-columns';
import {
  paymentQueryStateSchema,
  type TablePreferenceConfig,
} from '@/modules/payments/payments-filters';
import { PaymentsWorkspace } from '@/components/payments/PaymentsWorkspace';
import {
  getLatestPaymentsSyncRun,
  getActivePaymentsSyncRun,
  type SyncRunStatus,
} from '@/modules/integrations/zoho/payments-sync';
import { PAYMENT_ENTITY_TYPE } from '@/modules/payments/permissions';
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

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePermission('payments.view');
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

  const query = paymentQueryStateSchema.parse(queryInput);

  const [result, preference, views, defaultView, unreadCount, activeSyncRun, latestSyncRun] =
    await Promise.all([
      getPaymentsWorkspace(query),
      getUserTablePreference(user.id, PAYMENTS_TABLE_KEY),
      listTableViews(user.id, PAYMENTS_TABLE_KEY),
      getDefaultTableView(user.id, PAYMENTS_TABLE_KEY),
      getUnreadNotificationCount(user.id),
      getActivePaymentsSyncRun(),
      getLatestPaymentsSyncRun(),
    ]);

  const watchedIds = await getWatchedEntityIds(
    user.id,
    PAYMENT_ENTITY_TYPE,
    result.data.map((p) => p.id)
  );

  const canExport = hasPermission(user, 'payments.export');
  const canWatch = hasPermission(user, 'payments.watch');
  const canShareViews = hasPermission(user, 'payments.share_views');

  const defaultPreference: TablePreferenceConfig = {
    version: 1,
    columnOrder: PAYMENT_COLUMNS.sort((a, b) => a.priority - b.priority).map((c) => c.id),
    columnVisibility: Object.fromEntries(PAYMENT_COLUMNS.map((c) => [c.id, c.defaultVisible])),
    columnWidths: Object.fromEntries(PAYMENT_COLUMNS.map((c) => [c.id, c.defaultWidth])),
    columnPinning: { left: [], right: [] },
    density: 'normal',
    pageSize: 50,
  };

  return (
    <PaymentsWorkspace
      user={user}
      tableKey={PAYMENTS_TABLE_KEY}
      entityLabel="Pago"
      entityLabelPlural="Pagos"
      basePath="/app/payments"
      permissionView="payments.view"
      permissionExport="payments.export"
      permissionWatch="payments.watch"
      permissionShareViews="payments.share_views"
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
