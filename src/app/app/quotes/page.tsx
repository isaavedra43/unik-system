import { requirePermission, hasPermission } from '@/modules/auth/authorization';
import { getQuotesWorkspace, getQuoteSegmentCounts } from '@/modules/quotes/quotes-service';
import { getUserTablePreference } from '@/modules/sales/table-preferences-service';
import { listTableViews, getDefaultTableView } from '@/modules/sales/table-views-service';
import { getUnreadNotificationCount } from '@/modules/sales/notifications-service';
import { getWatchedEntityIds } from '@/modules/sales/entity-watch-service';
import { QUOTES_TABLE_KEY, QUOTE_COLUMNS } from '@/modules/quotes/quotes-columns';
import { quoteQueryStateSchema, type TablePreferenceConfig } from '@/modules/quotes/quotes-filters';
import { QuotesWorkspace } from '@/components/quotes/QuotesWorkspace';
import {
  getLatestEstimatesSyncRun, getActiveEstimatesSyncRun, type SyncRunStatus,
} from '@/modules/integrations/zoho/estimates-sync';
import { QUOTE_ENTITY_TYPE } from '@/modules/quotes/permissions';
import {
  saveTablePreferenceJson, resetTablePreferenceAction, createViewAction,
  watchAction, unwatchAction, bulkWatchAction, exportAction,
} from './actions';

export const runtime = 'nodejs';

interface SearchParams { search?: string; page?: string; page_size?: string; sort?: string; filters?: string; view?: string; segment?: string; }

export default async function QuotesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission('quotes.view');
  const params = await searchParams;

  const defaultSort: { field: string; direction: 'asc' | 'desc' }[] = [{ field: 'date', direction: 'desc' }];
  let sort = defaultSort;
  if (params.sort) { try { const parsed = JSON.parse(params.sort); sort = Array.isArray(parsed) && parsed.length > 0 ? parsed : defaultSort; } catch { sort = defaultSort; } }

  let filters = { logic: 'AND' as const, rules: [] };
  if (params.filters) { try { filters = JSON.parse(params.filters); } catch { filters = { logic: 'AND', rules: [] }; } }

  const parsedQuery = quoteQueryStateSchema.safeParse({
    search: params.search ?? '', filters, sort,
    segment: params.segment ?? 'all',
    page: params.page ? Number(params.page) : 1,
    page_size: params.page_size ? Number(params.page_size) : 50,
  });
  const query = parsedQuery.success
    ? parsedQuery.data
    : quoteQueryStateSchema.parse({ search: params.search ?? '', filters: { logic: 'AND', rules: [] }, sort: defaultSort, segment: 'all', page: 1, page_size: 50 });

  const [result, preference, views, defaultView, unreadCount, activeSyncRun, latestSyncRun, segmentCounts] = await Promise.all([
    getQuotesWorkspace(query, user.id),
    getUserTablePreference(user.id, QUOTES_TABLE_KEY),
    listTableViews(user.id, QUOTES_TABLE_KEY),
    getDefaultTableView(user.id, QUOTES_TABLE_KEY),
    getUnreadNotificationCount(user.id),
    getActiveEstimatesSyncRun(),
    getLatestEstimatesSyncRun(),
    getQuoteSegmentCounts(user.id),
  ]);

  const watchedIds = await getWatchedEntityIds(user.id, QUOTE_ENTITY_TYPE, result.data.map((p) => p.id));

  const canExport = hasPermission(user, 'quotes.export');
  const canWatch = hasPermission(user, 'quotes.watch');
  const canShareViews = hasPermission(user, 'quotes.share_views');
  const canCreate = hasPermission(user, 'quotes.create');

  const defaultPreference: TablePreferenceConfig = {
    version: 1,
    columnOrder: [...QUOTE_COLUMNS].sort((a, b) => a.priority - b.priority).map((c) => c.id),
    columnVisibility: Object.fromEntries(QUOTE_COLUMNS.map((c) => [c.id, c.defaultVisible])),
    columnWidths: Object.fromEntries(QUOTE_COLUMNS.map((c) => [c.id, c.defaultWidth])),
    columnPinning: { left: [], right: [] },
    density: 'normal', pageSize: 50,
  };

  return (
    <QuotesWorkspace
      user={user} tableKey={QUOTES_TABLE_KEY} entityLabel="Cotización" entityLabelPlural="Cotizaciones"
      basePath="/app/quotes" permissionView="quotes.view" permissionExport="quotes.export"
      permissionWatch="quotes.watch" permissionShareViews="quotes.share_views"
      initialData={result} initialQuery={query} preference={preference ?? defaultPreference}
      views={views} defaultViewId={defaultView?.id ?? null} watchedIds={watchedIds}
      unreadNotifications={unreadCount} canExport={canExport} canWatch={canWatch}
      canShareViews={canShareViews} canCreate={canCreate} segmentCounts={segmentCounts}
      initialSyncStatus={formatSyncStatus(latestSyncRun, activeSyncRun)}
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
