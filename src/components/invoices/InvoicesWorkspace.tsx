'use client';

import React from 'react';
import { EntityWorkspace } from '@/components/common/EntityWorkspace';
import {
  INVOICE_COLUMNS,
  INVOICE_COLUMN_MAP,
  INVOICE_DEFAULT_COLUMN_ORDER,
} from '@/modules/invoices/invoices-columns';
import {
  type InvoiceQueryState,
  type TablePreferenceConfig,
} from '@/modules/invoices/invoices-filters';
import { type InvoicesListResult, type InvoiceListRow } from '@/modules/invoices/invoices-service';
import {
  formatCurrency,
  formatDateOnly,
  getInvoiceStatusConfig,
  getInvoiceStatusLabel,
  getInvoiceStatusOptions,
} from '@/modules/invoices/invoices-helpers';
import { getSalesOrderStatusConfig } from '@/modules/sales/sales-orders-helpers';
import { InvoicePreviewDrawer } from './InvoicePreviewDrawer';
import { CurrentUser } from '@/modules/auth/authorization';
import type {
  EntityColumnDefinition,
  EntityListResult,
  EntityQueryState,
  SavePreferenceAction,
  ResetPreferenceAction,
  CreateViewAction,
  WatchAction,
  BulkWatchAction,
  ExportAction,
  SyncStatus,
  TableViewRow,
} from '@/modules/shared/entity-workspace-types';

export interface InvoicesWorkspaceProps {
  user: CurrentUser;
  tableKey: string;
  entityLabel: string;
  entityLabelPlural: string;
  basePath: string;
  permissionView: string;
  permissionExport: string;
  permissionWatch: string;
  permissionShareViews: string;
  initialData: InvoicesListResult;
  initialQuery: InvoiceQueryState;
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

function StatusCell({
  value,
  label,
  category,
}: {
  value: string | null;
  label: string;
  category?: 'invoice' | 'sales_order';
}) {
  const config =
    category === 'sales_order'
      ? getSalesOrderStatusConfig(value, 'order')
      : getInvoiceStatusConfig(value);
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

function renderCell(row: InvoiceListRow, column: EntityColumnDefinition): React.ReactNode {
  const value = (row as unknown as Record<string, unknown>)[column.id];
  if (value === null || value === undefined) return '—';
  if (column.formatter === 'currency') {
    return formatCurrency(value as string | number, row.currencyCode);
  }
  if (column.formatter === 'date') {
    return formatDateOnly(value as string | Date);
  }
  if (column.formatter === 'statusDot') {
    return (
      <StatusCell
        value={value as string | null}
        label={column.label}
        category={(column as { statusCategory?: 'invoice' | 'sales_order' }).statusCategory}
      />
    );
  }
  return String(value);
}

export function InvoicesWorkspace(props: InvoicesWorkspaceProps) {
  const initialQuery: EntityQueryState = {
    ...props.initialQuery,
    search: props.initialQuery.search ?? '',
  } as unknown as EntityQueryState;

  return (
    <EntityWorkspace<InvoiceListRow>
      user={props.user}
      tableKey={props.tableKey}
      entityLabel={props.entityLabel}
      entityLabelPlural={props.entityLabelPlural}
      basePath={props.basePath}
      permissionView={props.permissionView}
      permissionExport={props.permissionExport}
      permissionWatch={props.permissionWatch}
      permissionShareViews={props.permissionShareViews}
      initialData={props.initialData as unknown as EntityListResult<InvoiceListRow>}
      initialQuery={initialQuery}
      preference={props.preference as unknown as import('@/modules/shared/entity-workspace-types').TablePreferenceConfig}
      views={props.views}
      defaultViewId={props.defaultViewId}
      watchedIds={props.watchedIds}
      unreadNotifications={props.unreadNotifications}
      canExport={props.canExport}
      canWatch={props.canWatch}
      canShareViews={props.canShareViews}
      initialSyncStatus={props.initialSyncStatus}
      columns={INVOICE_COLUMNS as unknown as EntityColumnDefinition[]}
      columnMap={INVOICE_COLUMN_MAP as unknown as Record<string, EntityColumnDefinition>}
      defaultColumnOrder={INVOICE_DEFAULT_COLUMN_ORDER}
      renderCell={renderCell}
      getStatusLabel={getInvoiceStatusLabel}
      getStatusOptions={getInvoiceStatusOptions}
      formatCurrency={formatCurrency}
      formatDateOnly={formatDateOnly}
      nameField="invoiceNumber"
      searchPlaceholder="Buscar facturas..."
      savePreferenceAction={props.savePreferenceAction}
      resetPreferenceAction={props.resetPreferenceAction}
      createViewAction={props.createViewAction}
      watchAction={props.watchAction}
      unwatchAction={props.unwatchAction}
      bulkWatchAction={props.bulkWatchAction}
      exportAction={props.exportAction}
      renderPreviewDrawer={({ entityId, ...rest }) => (
        <InvoicePreviewDrawer invoiceId={entityId} {...rest} />
      )}
    />
  );
}
