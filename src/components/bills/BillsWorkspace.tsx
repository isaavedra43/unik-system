'use client';

import React, { useCallback } from 'react';
import { EntityWorkspace, type EntityWorkspaceProps } from '@/components/common/EntityWorkspace';
import {
  BILL_COLUMNS,
  BILL_COLUMN_MAP,
  BILL_DEFAULT_COLUMN_ORDER,
} from '@/modules/bills/bills-columns';
import type { BillListRow } from '@/modules/bills/bills-service';
import {
  formatCurrency,
  formatDateOnly,
  formatNumber,
  getBillStatusConfig,
  getBillStatusLabel,
  getBillStatusOptions,
} from '@/modules/bills/bills-helpers';
import { BillPreviewDrawer } from './BillPreviewDrawer';
import type { EntityColumnDefinition } from '@/modules/shared/entity-workspace-types';

type BillsWorkspaceProps = Omit<
  EntityWorkspaceProps<BillListRow>,
  | 'columns'
  | 'columnMap'
  | 'defaultColumnOrder'
  | 'renderCell'
  | 'getStatusLabel'
  | 'getStatusOptions'
  | 'formatCurrency'
  | 'formatDateOnly'
  | 'nameField'
  | 'searchPlaceholder'
>;

export function BillsWorkspace(props: BillsWorkspaceProps) {
  const renderCell = useCallback(
    (row: BillListRow, column: EntityColumnDefinition): React.ReactNode => {
      const value = (row as unknown as Record<string, unknown>)[column.id];
      if (value === null || value === undefined) return '—';
      if (column.formatter === 'currency')
        return formatCurrency(value as string | number, row.currencyCode);
      if (column.formatter === 'date') return formatDateOnly(value as string | Date);
      if (column.formatter === 'statusDot') {
        const config = getBillStatusConfig(value as string | null);
        return (
          <span className="inline-flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                config.tone === 'success'
                  ? 'bg-success'
                  : config.tone === 'danger'
                    ? 'bg-destructive'
                    : config.tone === 'warning'
                      ? 'bg-warning'
                      : config.tone === 'info'
                        ? 'bg-primary'
                        : 'bg-muted-foreground'
              }`}
            />
            {config.label}
          </span>
        );
      }
      if (column.type === 'number') return formatNumber(value as string | number);
      return String(value);
    },
    []
  );

  return (
    <EntityWorkspace<BillListRow>
      {...props}
      columns={BILL_COLUMNS}
      columnMap={BILL_COLUMN_MAP}
      defaultColumnOrder={BILL_DEFAULT_COLUMN_ORDER}
      renderCell={renderCell}
      getStatusLabel={getBillStatusLabel}
      getStatusOptions={getBillStatusOptions}
      formatCurrency={formatCurrency}
      formatDateOnly={formatDateOnly}
      nameField="billNumber"
      searchPlaceholder="Buscar por folio, proveedor..."
      renderPreviewDrawer={({ entityId, ...drawerProps }) => (
        <BillPreviewDrawer {...drawerProps} billId={entityId} />
      )}
    />
  );
}
