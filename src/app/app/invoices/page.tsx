import { requirePermission, hasPermission } from '@/modules/auth/authorization';
import { getInvoicesWorkspace } from '@/modules/invoices/invoices-service';
import { getUserTablePreference } from '@/modules/sales/table-preferences-service';
import { listTableViews, getDefaultTableView } from '@/modules/sales/table-views-service';
import { getUnreadNotificationCount } from '@/modules/sales/notifications-service';
import { getWatchedEntityIds } from '@/modules/sales/entity-watch-service';
import { INVOICES_TABLE_KEY, INVOICE_COLUMNS } from '@/modules/invoices/invoices-columns';
import { invoiceQueryStateSchema, type TablePreferenceConfig } from '@/modules/invoices/invoices-filters';
import { InvoicesWorkspace } from '@/components/invoices/InvoicesWorkspace';
import {
  getLatestInvoicesSyncRun, getActiveInvoicesSyncRun, type SyncRunStatus,
} from '@/modules/integrations/zoho/invoices-sync';
import { INVOICE_ENTITY_TYPE } from '@/modules/invoices/permissions';
import {
  saveTablePreferenceJson, resetTablePreferenceAction, createViewAction,
  watchAction, unwatchAction, bulkWatchAction, exportAction,
} from './actions';

export const runtime = 'nodejs';

interface SearchParams { search?: string; page?: string; page_size?: string; sort?: string; filters?: string; view?: string; }

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission('invoices.view');
  const params = await searchParams;

  const defaultSort: { field: string; direction: 'asc' | 'desc' }[] = [{ field: 'invoiceNumber', direction: 'asc' }];
  let sort = defaultSort;
  if (params.sort) { try { const parsed = JSON.parse(params.sort); sort = Array.isArray(parsed) && parsed.length > 0 ? parsed : defaultSort; } catch { sort = defaultSort; } }

  let filters = { logic: 'AND' as const, rules: [] };
  if (params.filters) { try { filters = JSON.parse(params.filters); } catch { filters = { logic: 'AND', rules: [] }; } }

  const query = invoiceQueryStateSchema.parse({
    search: params.search ?? '', filters, sort,
    page: params.page ? Number(params.page) : 1,
    page_size: params.page_size ? Number(params.page_size) : 50,
  });

  const [result, preference, views, defaultView, unreadCount, activeSyncRun, latestSyncRun] = await Promise.all([
    getInvoicesWorkspace(query),
    getUserTablePreference(user.id, INVOICES_TABLE_KEY),
    listTableViews(user.id, INVOICES_TABLE_KEY),
    getDefaultTableView(user.id, INVOICES_TABLE_KEY),
    getUnreadNotificationCount(user.id),
    getActiveInvoicesSyncRun(),
    getLatestInvoicesSyncRun(),
  ]);

  const watchedIds = await getWatchedEntityIds(user.id, INVOICE_ENTITY_TYPE, result.data.map((p) => p.id));

  const canExport = hasPermission(user, 'invoices.export');
  const canWatch = hasPermission(user, 'invoices.watch');
  const canShareViews = hasPermission(user, 'invoices.share_views');

  const defaultPreference: TablePreferenceConfig = {
    version: 1,
    columnOrder: INVOICE_COLUMNS.sort((a, b) => a.priority - b.priority).map((c) => c.id),
    columnVisibility: Object.fromEntries(INVOICE_COLUMNS.map((c) => [c.id, c.defaultVisible])),
    columnWidths: Object.fromEntries(INVOICE_COLUMNS.map((c) => [c.id, c.defaultWidth])),
    columnPinning: { left: [], right: [] },
    density: 'normal', pageSize: 50,
  };

  return (
    <InvoicesWorkspace
      user={user} tableKey={INVOICES_TABLE_KEY} entityLabel="Factura" entityLabelPlural="Facturas"
      basePath="/app/invoices" permissionView="invoices.view" permissionExport="invoices.export"
      permissionWatch="invoices.watch" permissionShareViews="invoices.share_views"
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
