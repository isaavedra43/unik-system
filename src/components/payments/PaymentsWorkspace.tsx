'use client';

import React from 'react';
import { EntityWorkspace } from '@/components/common/EntityWorkspace';
import {
  PAYMENT_COLUMNS,
  PAYMENT_COLUMN_MAP,
  PAYMENT_DEFAULT_COLUMN_ORDER,
} from '@/modules/payments/payments-columns';
import {
  type PaymentQueryState,
  type TablePreferenceConfig,
} from '@/modules/payments/payments-filters';
import { type PaymentsListResult, type PaymentListRow } from '@/modules/payments/payments-service';
import {
  formatCurrency,
  formatDateOnly,
  getPaymentStatusConfig,
  getPaymentStatusLabel,
  getPaymentStatusOptions,
} from '@/modules/payments/payments-helpers';
import { PaymentPreviewDrawer } from './PaymentPreviewDrawer';
import { CurrentUser } from '@/modules/auth/authorization';
import type {
  EntityColumnDefinition,
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

export interface PaymentsWorkspaceProps {
  user: CurrentUser;
  tableKey: string;
  entityLabel: string;
  entityLabelPlural: string;
  basePath: string;
  permissionView: string;
  permissionExport: string;
  permissionWatch: string;
  permissionShareViews: string;
  initialData: PaymentsListResult;
  initialQuery: PaymentQueryState;
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
  const config = getPaymentStatusConfig(value);
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

function renderCell(row: PaymentListRow, column: EntityColumnDefinition): React.ReactNode {
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
    return <StatusCell value={value as string | null} label={column.label} />;
  }
  if (value === null || value === undefined) return '—';
  return String(value);
}

function getStatusConfigAdapter(value: string | null): StatusConfig {
  const config = getPaymentStatusConfig(value);
  return { label: config.label, tone: config.tone };
}

export function PaymentsWorkspace(props: PaymentsWorkspaceProps) {
  // EntityQueryState expects `search` as a required string; PaymentQueryState
  // allows it to be optional, so normalize it here. Filter rule values are
  // always strings at runtime (deserialized from JSON), so the Date-typed
  // union in the Zod schema is structurally compatible via this cast.
  const initialQuery = {
    ...props.initialQuery,
    search: props.initialQuery.search ?? '',
  } as unknown as EntityQueryState;

  return (
    <EntityWorkspace<PaymentListRow>
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
      columns={PAYMENT_COLUMNS}
      columnMap={PAYMENT_COLUMN_MAP}
      defaultColumnOrder={PAYMENT_DEFAULT_COLUMN_ORDER}
      renderCell={renderCell}
      getStatusConfig={getStatusConfigAdapter}
      getStatusLabel={getPaymentStatusLabel}
      getStatusOptions={getPaymentStatusOptions}
      formatCurrency={formatCurrency}
      formatDateOnly={formatDateOnly}
      nameField="paymentNumber"
      searchPlaceholder="Buscar por folio, cliente, referencia..."
      savePreferenceAction={props.savePreferenceAction}
      resetPreferenceAction={props.resetPreferenceAction}
      createViewAction={props.createViewAction}
      watchAction={props.watchAction}
      unwatchAction={props.unwatchAction}
      bulkWatchAction={props.bulkWatchAction}
      exportAction={props.exportAction}
      renderPreviewDrawer={(drawerProps) => (
        <PaymentPreviewDrawer {...drawerProps} />
      )}
    />
  );
}
