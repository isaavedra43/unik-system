'use client';

import React from 'react';
import { EntityWorkspace } from '@/components/common/EntityWorkspace';
import {
  PRODUCT_COLUMNS,
  PRODUCT_COLUMN_MAP,
  PRODUCT_DEFAULT_COLUMN_ORDER,
} from '@/modules/products/products-columns';
import {
  type ProductQueryState,
  type TablePreferenceConfig,
} from '@/modules/products/products-filters';
import { type ProductsListResult, type ProductListRow } from '@/modules/products/products-service';
import {
  formatCurrency,
  formatDateOnly,
  formatNumber,
  getProductStatusConfig,
  getProductStatusLabel,
  getProductStatusOptions,
} from '@/modules/products/products-helpers';
import { ProductPreviewDrawer } from './ProductPreviewDrawer';
import type { CurrentUser } from '@/modules/auth/authorization';
import type {
  EntityColumnDefinition,
  EntityListResult,
  EntityQueryState,
  StatusConfig,
  SyncStatus,
  TableViewRow,
  SavePreferenceAction,
  ResetPreferenceAction,
  CreateViewAction,
  WatchAction,
  BulkWatchAction,
  ExportAction,
} from '@/modules/shared/entity-workspace-types';

export interface ProductsWorkspaceProps {
  user: CurrentUser;
  tableKey: string;
  entityLabel: string;
  entityLabelPlural: string;
  basePath: string;
  permissionView: string;
  permissionExport: string;
  permissionWatch: string;
  permissionShareViews: string;
  initialData: ProductsListResult;
  initialQuery: ProductQueryState;
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

function StatusCell({ value, label }: { value: string | null; label: string }) {
  const config = getProductStatusConfig(value);
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

function renderCell(row: ProductListRow, column: EntityColumnDefinition): React.ReactNode {
  const value = (row as unknown as Record<string, unknown>)[column.id];
  if (value === null || value === undefined) return '—';
  if (column.formatter === 'currency') {
    return (
      <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', display: 'block' }}>
        {formatCurrency(value as string | number, row.currencyCode)}
      </span>
    );
  }
  if (column.formatter === 'date') {
    return formatDateOnly(value as string | Date);
  }
  if (column.formatter === 'statusDot') {
    return <StatusCell value={value as string | null} label={column.label} />;
  }
  if (column.formatter === 'boolean') {
    return value === true ? 'Sí' : value === false ? 'No' : '—';
  }
  if (column.type === 'number') {
    return formatNumber(value as string | number);
  }
  return String(value);
}

function getStatusConfigAdapter(value: string | null): StatusConfig {
  const config = getProductStatusConfig(value);
  return { label: config.label, tone: config.tone };
}

export function ProductsWorkspace(props: ProductsWorkspaceProps) {
  const initialQuery = {
    ...props.initialQuery,
    search: props.initialQuery.search ?? '',
  } as unknown as EntityQueryState;

  return (
    <EntityWorkspace<ProductListRow>
      user={props.user}
      tableKey={props.tableKey}
      entityLabel={props.entityLabel}
      entityLabelPlural={props.entityLabelPlural}
      basePath={props.basePath}
      permissionView={props.permissionView}
      permissionExport={props.permissionExport}
      permissionWatch={props.permissionWatch}
      permissionShareViews={props.permissionShareViews}
      initialData={props.initialData as unknown as EntityListResult<ProductListRow>}
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
      columns={PRODUCT_COLUMNS}
      columnMap={PRODUCT_COLUMN_MAP}
      defaultColumnOrder={PRODUCT_DEFAULT_COLUMN_ORDER}
      renderCell={renderCell}
      getStatusConfig={getStatusConfigAdapter}
      getStatusLabel={getProductStatusLabel}
      getStatusOptions={getProductStatusOptions}
      formatCurrency={formatCurrency}
      formatDateOnly={formatDateOnly}
      nameField="name"
      searchPlaceholder="Buscar productos..."
      savePreferenceAction={props.savePreferenceAction}
      resetPreferenceAction={props.resetPreferenceAction}
      createViewAction={props.createViewAction}
      watchAction={props.watchAction}
      unwatchAction={props.unwatchAction}
      bulkWatchAction={props.bulkWatchAction}
      exportAction={props.exportAction}
      renderPreviewDrawer={({ entityId, ...drawerProps }) => (
        <ProductPreviewDrawer {...drawerProps} productId={entityId} />
      )}
    />
  );
}
