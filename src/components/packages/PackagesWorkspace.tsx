'use client';

import React from 'react';
import { EntityWorkspace } from '@/components/common/EntityWorkspace';
import { PACKAGE_COLUMNS, PACKAGE_COLUMN_MAP } from '@/modules/packages/packages-columns';
import {
  type PackageQueryState,
  type TablePreferenceConfig,
} from '@/modules/packages/packages-filters';
import { type PackagesListResult, type PackageListRow } from '@/modules/packages/packages-service';
import {
  formatCurrency,
  formatDateOnly,
  getPackageStatusConfig,
  getPackageStatusLabel,
  getPackageStatusOptions,
} from '@/modules/packages/packages-helpers';
import { PackagePreviewDrawer } from './PackagePreviewDrawer';
import { CurrentUser } from '@/modules/auth/authorization';
import type {
  EntityColumnDefinition,
  EntityListResult,
  EntityQueryState,
  SyncStatus,
  TableViewRow,
  SavePreferenceAction,
  ResetPreferenceAction,
  CreateViewAction,
  WatchAction,
  BulkWatchAction,
  ExportAction,
} from '@/modules/shared/entity-workspace-types';

export interface PackagesWorkspaceProps {
  user: CurrentUser;
  tableKey: string;
  entityLabel: string;
  entityLabelPlural: string;
  basePath: string;
  permissionView: string;
  permissionExport: string;
  permissionWatch: string;
  permissionShareViews: string;
  initialData: PackagesListResult;
  initialQuery: PackageQueryState;
  preference: TablePreferenceConfig;
  views: { privateViews: TableViewRow[]; sharedViews: TableViewRow[] };
  defaultViewId: string | null;
  watchedIds: Set<string>;
  unreadNotifications: number;
  canExport: boolean;
  canWatch: boolean;
  canShareViews: boolean;
  initialSyncStatus?: SyncStatus | null;
  savePreferenceAction: SavePreferenceAction;
  resetPreferenceAction: ResetPreferenceAction;
  createViewAction: CreateViewAction;
  watchAction: WatchAction;
  unwatchAction: WatchAction;
  bulkWatchAction: BulkWatchAction;
  exportAction: ExportAction;
}

const defaultColumnOrder = [...PACKAGE_COLUMNS]
  .sort((a, b) => a.priority - b.priority)
  .map((c) => c.id);

function StatusCell({ value, label }: { value: string | null; label: string }) {
  const config = getPackageStatusConfig(value);
  if (!value) {
    return (
      <span className="so-status-cell">
        <span className="so-status-dot so-status-dot-muted" />
        <span className="text-muted">—</span>
      </span>
    );
  }
  return (
    <span className="so-status-cell" title={`${label}: ${config.label}`}>
      <span className={`so-status-dot so-status-dot-${config.tone}`} />
      <span>{config.label}</span>
    </span>
  );
}

function renderCell(row: PackageListRow, column: EntityColumnDefinition): React.ReactNode {
  const value = (row as unknown as Record<string, unknown>)[column.id];
  if (column.formatter === 'currency') {
    return (
      <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', display: 'block' }}>
        {formatCurrency(
          value as string | number | null,
          (row as unknown as Record<string, unknown>).currencyCode as string | null | undefined
        )}
      </span>
    );
  }
  if (column.formatter === 'date') {
    return formatDateOnly(value as string | Date | null);
  }
  if (column.formatter === 'statusDot') {
    return <StatusCell value={value as string | null} label={column.label} />;
  }
  if (value === null || value === undefined) return '—';
  return String(value);
}

function getStatusConfigAdapter(value: string | null) {
  const config = getPackageStatusConfig(value);
  return { label: config.label, tone: config.tone };
}

export function PackagesWorkspace(props: PackagesWorkspaceProps) {
  const initialQuery = {
    ...props.initialQuery,
    search: props.initialQuery.search ?? '',
  } as unknown as EntityQueryState;

  return (
    <EntityWorkspace<PackageListRow>
      user={props.user}
      tableKey={props.tableKey}
      entityLabel={props.entityLabel}
      entityLabelPlural={props.entityLabelPlural}
      basePath={props.basePath}
      permissionView={props.permissionView}
      permissionExport={props.permissionExport}
      permissionWatch={props.permissionWatch}
      permissionShareViews={props.permissionShareViews}
      initialData={props.initialData as unknown as EntityListResult<PackageListRow>}
      initialQuery={initialQuery}
      preference={props.preference}
      views={props.views}
      defaultViewId={props.defaultViewId}
      watchedIds={props.watchedIds}
      unreadNotifications={props.unreadNotifications}
      canExport={props.canExport}
      canWatch={props.canWatch}
      canShareViews={props.canShareViews}
      initialSyncStatus={props.initialSyncStatus}
      columns={PACKAGE_COLUMNS as unknown as EntityColumnDefinition[]}
      columnMap={PACKAGE_COLUMN_MAP as unknown as Record<string, EntityColumnDefinition>}
      defaultColumnOrder={defaultColumnOrder}
      renderCell={renderCell}
      getStatusConfig={getStatusConfigAdapter}
      getStatusLabel={getPackageStatusLabel}
      getStatusOptions={getPackageStatusOptions}
      formatCurrency={formatCurrency}
      formatDateOnly={formatDateOnly}
      nameField="packageNumber"
      searchPlaceholder="Buscar paquetes..."
      savePreferenceAction={props.savePreferenceAction}
      resetPreferenceAction={props.resetPreferenceAction}
      createViewAction={props.createViewAction}
      watchAction={props.watchAction}
      unwatchAction={props.unwatchAction}
      bulkWatchAction={props.bulkWatchAction}
      exportAction={props.exportAction}
      renderPreviewDrawer={(drawerProps) => (
        <PackagePreviewDrawer {...drawerProps} packageId={drawerProps.entityId} />
      )}
    />
  );
}
