'use client';

import React from 'react';
import { CurrentUser } from '@/modules/auth/authorization';
import {
  EntityWorkspace,
  type EntityWorkspaceProps,
} from '@/components/common/EntityWorkspace';
import { PurchaseOrderPreviewDrawer } from './PurchaseOrderPreviewDrawer';
import {
  PURCHASE_ORDER_COLUMNS,
  PURCHASE_ORDER_COLUMN_MAP,
  PURCHASE_ORDER_DEFAULT_COLUMN_ORDER,
} from '@/modules/purchase-orders/purchase-orders-columns';
import type {
  EntityColumnDefinition,
  TablePreferenceConfig,
  EntityQueryState,
  EntityListResult,
  TableViewRow,
  SyncStatus,
  SavePreferenceAction,
  ResetPreferenceAction,
  CreateViewAction,
  WatchAction,
  BulkWatchAction,
  ExportAction,
} from '@/modules/shared/entity-workspace-types';
import type { PurchaseOrderListRow } from '@/modules/purchase-orders/purchase-orders-contract';
import {
  formatCurrency,
  formatDateOnly,
  getPurchaseOrderStatusConfig,
  getPurchaseOrderStatusLabel,
  getPurchaseOrderStatusOptions,
} from '@/modules/purchase-orders/purchase-orders-helpers';

export interface PurchaseOrdersWorkspaceProps {
  user: CurrentUser;
  tableKey: string;
  entityLabel: string;
  entityLabelPlural: string;
  basePath: string;
  permissionView: string;
  permissionExport: string;
  permissionWatch: string;
  permissionShareViews: string;
  initialData: EntityListResult<PurchaseOrderListRow>;
  initialQuery: EntityQueryState;
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

function renderCell(
  row: PurchaseOrderListRow,
  column: EntityColumnDefinition
): React.ReactNode {
  const value = (row as unknown as Record<string, unknown>)[column.id];
  if (column.formatter === 'currency') {
    return (
      <span
        style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', display: 'block' }}
      >
        {formatCurrency(value as string | null, row.currencyCode)}
      </span>
    );
  }
  if (column.formatter === 'date') {
    return formatDateOnly(value as string | null);
  }
  if (column.formatter === 'statusDot') {
    const config = getPurchaseOrderStatusConfig(value as string | null);
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

export function PurchaseOrdersWorkspace(props: PurchaseOrdersWorkspaceProps) {
  const entityWorkspaceProps: EntityWorkspaceProps<PurchaseOrderListRow> = {
    user: props.user,
    tableKey: props.tableKey,
    entityLabel: props.entityLabel,
    entityLabelPlural: props.entityLabelPlural,
    basePath: props.basePath,
    permissionView: props.permissionView,
    permissionExport: props.permissionExport,
    permissionWatch: props.permissionWatch,
    permissionShareViews: props.permissionShareViews,
    initialData: props.initialData,
    initialQuery: props.initialQuery,
    preference: props.preference,
    views: props.views,
    defaultViewId: props.defaultViewId,
    watchedIds: props.watchedIds,
    unreadNotifications: props.unreadNotifications,
    canExport: props.canExport,
    canWatch: props.canWatch,
    canShareViews: props.canShareViews,
    initialSyncStatus: props.initialSyncStatus,
    columns: PURCHASE_ORDER_COLUMNS,
    columnMap: PURCHASE_ORDER_COLUMN_MAP,
    defaultColumnOrder: PURCHASE_ORDER_DEFAULT_COLUMN_ORDER,
    renderCell,
    getStatusLabel: getPurchaseOrderStatusLabel,
    getStatusOptions: getPurchaseOrderStatusOptions,
    formatCurrency,
    formatDateOnly,
    nameField: 'purchaseOrderNumber',
    searchPlaceholder: 'Buscar por folio, proveedor, referencia...',
    savePreferenceAction: props.savePreferenceAction,
    resetPreferenceAction: props.resetPreferenceAction,
    createViewAction: props.createViewAction,
    watchAction: props.watchAction,
    unwatchAction: props.unwatchAction,
    bulkWatchAction: props.bulkWatchAction,
    exportAction: props.exportAction,
    renderPreviewDrawer: (drawerProps) => <PurchaseOrderPreviewDrawer {...drawerProps} />,
  };

  return <EntityWorkspace<PurchaseOrderListRow> {...entityWorkspaceProps} />;
}
