import { requirePermission, hasPermission } from '@/modules/auth/authorization';
import { getVendorCreditsWorkspace } from '@/modules/vendor-credits/vendor-credits-service';
import { getUserTablePreference } from '@/modules/sales/table-preferences-service';
import { listTableViews, getDefaultTableView } from '@/modules/sales/table-views-service';
import { getUnreadNotificationCount } from '@/modules/sales/notifications-service';
import { getWatchedEntityIds } from '@/modules/sales/entity-watch-service';
import {
  VENDOR_CREDITS_TABLE_KEY,
  VENDOR_CREDIT_COLUMNS,
} from '@/modules/vendor-credits/vendor-credits-columns';
import {
  vendorCreditQueryStateSchema,
  type TablePreferenceConfig,
} from '@/modules/vendor-credits/vendor-credits-filters';
import { VendorCreditsWorkspace } from '@/components/vendor-credits/VendorCreditsWorkspace';
import { VENDOR_CREDIT_ENTITY_TYPE } from '@/modules/vendor-credits/permissions';
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

export default async function VendorCreditsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePermission('vendor_credits.view');
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

  const query = vendorCreditQueryStateSchema.parse(queryInput);

  const [result, preference, views, defaultView, unreadCount] = await Promise.all([
    getVendorCreditsWorkspace(query),
    getUserTablePreference(user.id, VENDOR_CREDITS_TABLE_KEY),
    listTableViews(user.id, VENDOR_CREDITS_TABLE_KEY),
    getDefaultTableView(user.id, VENDOR_CREDITS_TABLE_KEY),
    getUnreadNotificationCount(user.id),
  ]);

  const watchedIds = await getWatchedEntityIds(
    user.id,
    VENDOR_CREDIT_ENTITY_TYPE,
    result.data.map((vc) => vc.id)
  );

  const canExport = hasPermission(user, 'vendor_credits.export');
  const canWatch = hasPermission(user, 'vendor_credits.watch');
  // vendor_credits.share_views is not yet a registered permission; disabled by default.
  const canShareViews = false;

  const defaultPreference: TablePreferenceConfig = {
    version: 1,
    columnOrder: [...VENDOR_CREDIT_COLUMNS]
      .sort((a, b) => a.priority - b.priority)
      .map((c) => c.id),
    columnVisibility: Object.fromEntries(
      VENDOR_CREDIT_COLUMNS.map((c) => [c.id, c.defaultVisible])
    ),
    columnWidths: Object.fromEntries(
      VENDOR_CREDIT_COLUMNS.map((c) => [c.id, c.defaultWidth])
    ),
    columnPinning: { left: [], right: [] },
    density: 'normal',
    pageSize: 50,
  };

  return (
    <VendorCreditsWorkspace
      user={user}
      tableKey={VENDOR_CREDITS_TABLE_KEY}
      entityLabel="Crédito de proveedor"
      entityLabelPlural="Créditos de proveedor"
      basePath="/app/vendor-credits"
      permissionView="vendor_credits.view"
      permissionExport="vendor_credits.export"
      permissionWatch="vendor_credits.watch"
      permissionShareViews="vendor_credits.share_views"
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
