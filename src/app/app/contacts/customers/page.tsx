import { requirePermission, hasPermission } from '@/modules/auth/authorization';
import { getContactsWorkspace } from '@/modules/contacts/contacts-service';
import { getUserTablePreference } from '@/modules/sales/table-preferences-service';
import { listTableViews, getDefaultTableView } from '@/modules/sales/table-views-service';
import { getUnreadNotificationCount } from '@/modules/sales/notifications-service';
import { getWatchedEntityIds } from '@/modules/sales/entity-watch-service';
import {
  CONTACTS_TABLE_KEY_CUSTOMERS,
  CONTACT_COLUMNS,
} from '@/modules/contacts/contacts-columns';
import {
  contactQueryStateSchema,
  type TablePreferenceConfig,
} from '@/modules/contacts/contacts-filters';
import { ContactsWorkspace } from '@/components/contacts/ContactsWorkspace';
import {
  getLatestContactsSyncRun,
  getActiveContactsSyncRun,
  type SyncRunStatus,
} from '@/modules/integrations/zoho/contacts-sync';
import { CONTACT_ENTITY_TYPE_CUSTOMER } from '@/modules/contacts/permissions';
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

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePermission('customers.view');
  const params = await searchParams;

  const defaultSort: { field: string; direction: 'asc' | 'desc' }[] = [
    { field: 'contactName', direction: 'asc' },
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
    contactType: 'customer' as const,
  };

  const query = contactQueryStateSchema.parse(queryInput);

  const [result, preference, views, defaultView, unreadCount, activeSyncRun, latestSyncRun] =
    await Promise.all([
      getContactsWorkspace(query, 'customer'),
      getUserTablePreference(user.id, CONTACTS_TABLE_KEY_CUSTOMERS),
      listTableViews(user.id, CONTACTS_TABLE_KEY_CUSTOMERS),
      getDefaultTableView(user.id, CONTACTS_TABLE_KEY_CUSTOMERS),
      getUnreadNotificationCount(user.id),
      getActiveContactsSyncRun(),
      getLatestContactsSyncRun(),
    ]);

  const watchedIds = await getWatchedEntityIds(
    user.id,
    CONTACT_ENTITY_TYPE_CUSTOMER,
    result.data.map((c) => c.id)
  );

  const canExport = hasPermission(user, 'customers.export');
  const canWatch = hasPermission(user, 'customers.watch');
  const canShareViews = hasPermission(user, 'customers.share_views');

  const defaultPreference: TablePreferenceConfig = {
    version: 1,
    columnOrder: CONTACT_COLUMNS.sort((a, b) => a.priority - b.priority).map((c) => c.id),
    columnVisibility: Object.fromEntries(CONTACT_COLUMNS.map((c) => [c.id, c.defaultVisible])),
    columnWidths: Object.fromEntries(CONTACT_COLUMNS.map((c) => [c.id, c.defaultWidth])),
    columnPinning: { left: [], right: [] },
    density: 'normal',
    pageSize: 50,
  };

  return (
    <ContactsWorkspace
      user={user}
      contactType="customer"
      tableKey={CONTACTS_TABLE_KEY_CUSTOMERS}
      entityLabel="Cliente"
      entityLabelPlural="Clientes"
      basePath="/app/contacts/customers"
      permissionView="customers.view"
      permissionExport="customers.export"
      permissionWatch="customers.watch"
      permissionShareViews="customers.share_views"
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
