'use client';

import React from 'react';
import { CurrentUser } from '@/modules/auth/authorization';
import { EntityWorkspace } from '@/components/common/EntityWorkspace';
import {
  VENDOR_CREDIT_COLUMNS,
  VENDOR_CREDIT_COLUMN_MAP,
  VENDOR_CREDIT_DEFAULT_COLUMN_ORDER,
} from '@/modules/vendor-credits/vendor-credits-columns';
import type { EntityColumnDefinition } from '@/modules/shared/entity-workspace-types';
import {
  type TablePreferenceConfig,
  type EntityQueryState,
  type EntityListResult,
  type SavePreferenceAction,
  type ResetPreferenceAction,
  type CreateViewAction,
  type WatchAction,
  type BulkWatchAction,
  type ExportAction,
  type TableViewRow,
} from '@/modules/shared/entity-workspace-types';
import type { VendorCreditListRow } from '@/modules/vendor-credits/vendor-credits-service';
import { VendorCreditPreviewDrawer } from '@/components/vendor-credits/VendorCreditPreviewDrawer';
import {
  formatCurrency,
  formatDateOnly,
  getVendorCreditStatusConfig,
  getVendorCreditStatusLabel,
  getVendorCreditStatusOptions,
} from '@/modules/vendor-credits/vendor-credits-helpers';

export interface VendorCreditsWorkspaceProps {
  user: CurrentUser;
  tableKey: string;
  entityLabel: string;
  entityLabelPlural: string;
  basePath: string;
  permissionView: string;
  permissionExport: string;
  permissionWatch: string;
  permissionShareViews: string;
  initialData: EntityListResult<VendorCreditListRow>;
  initialQuery: EntityQueryState;
  preference: TablePreferenceConfig;
  views: { privateViews: TableViewRow[]; sharedViews: TableViewRow[] };
  defaultViewId: string | null;
  watchedIds: Set<string>;
  unreadNotifications: number;
  canExport: boolean;
  canWatch: boolean;
  canShareViews: boolean;
  savePreferenceAction: SavePreferenceAction;
  resetPreferenceAction: ResetPreferenceAction;
  createViewAction: CreateViewAction;
  watchAction: WatchAction;
  unwatchAction: WatchAction;
  bulkWatchAction: BulkWatchAction;
  exportAction: ExportAction;
}

function renderCell(
  row: VendorCreditListRow,
  column: EntityColumnDefinition
): React.ReactNode {
  const value = (row as unknown as Record<string, unknown>)[column.id];
  if (column.formatter === 'currency') {
    return (
      <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', display: 'block' }}>
        {formatCurrency(value as string | null, row.currencyCode)}
      </span>
    );
  }
  if (column.formatter === 'date') {
    return formatDateOnly(value as string | null);
  }
  if (column.formatter === 'statusDot') {
    const config = getVendorCreditStatusConfig(value as string | null);
    if (!value) {
      return (
        <span className="so-status-cell">
          <span className="so-status-dot so-status-dot-muted" />
          <span className="text-muted">—</span>
        </span>
      );
    }
    return (
      <span className="so-status-cell" title={`${column.label}: ${config.label}`}>
        <span className={`so-status-dot so-status-dot-${config.tone}`} />
        <span>{config.label}</span>
      </span>
    );
  }
  if (column.formatter === 'boolean') {
    return value === true ? 'Sí' : value === false ? 'No' : '—';
  }
  if (value === null || value === undefined) return '—';
  return String(value);
}

export function VendorCreditsWorkspace(props: VendorCreditsWorkspaceProps) {
  return (
    <EntityWorkspace<VendorCreditListRow>
      user={props.user}
      tableKey={props.tableKey}
      entityLabel={props.entityLabel}
      entityLabelPlural={props.entityLabelPlural}
      basePath={props.basePath}
      permissionView={props.permissionView}
      permissionExport={props.permissionExport}
      permissionWatch={props.permissionWatch}
      permissionShareViews={props.permissionShareViews}
      initialData={props.initialData}
      initialQuery={props.initialQuery}
      preference={props.preference}
      views={props.views}
      defaultViewId={props.defaultViewId}
      watchedIds={props.watchedIds}
      unreadNotifications={props.unreadNotifications}
      canExport={props.canExport}
      canWatch={props.canWatch}
      canShareViews={props.canShareViews}
      columns={VENDOR_CREDIT_COLUMNS}
      columnMap={VENDOR_CREDIT_COLUMN_MAP}
      defaultColumnOrder={VENDOR_CREDIT_DEFAULT_COLUMN_ORDER}
      renderCell={renderCell}
      getStatusLabel={getVendorCreditStatusLabel}
      getStatusOptions={getVendorCreditStatusOptions}
      formatCurrency={formatCurrency}
      formatDateOnly={formatDateOnly}
      nameField="vendorCreditNumber"
      searchPlaceholder="Buscar por folio, proveedor..."
      savePreferenceAction={props.savePreferenceAction}
      resetPreferenceAction={props.resetPreferenceAction}
      createViewAction={props.createViewAction}
      watchAction={props.watchAction}
      unwatchAction={props.unwatchAction}
      bulkWatchAction={props.bulkWatchAction}
      exportAction={props.exportAction}
      renderPreviewDrawer={({ entityId, ...drawerProps }) => (
        <VendorCreditPreviewDrawer {...drawerProps} vendorCreditId={entityId} />
      )}
    />
  );
}
