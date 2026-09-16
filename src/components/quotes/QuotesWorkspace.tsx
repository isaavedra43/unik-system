'use client';

import React from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { EntityWorkspace } from '@/components/common/EntityWorkspace';
import {
  QUOTE_COLUMNS,
  QUOTE_COLUMN_MAP,
  QUOTE_DEFAULT_COLUMN_ORDER,
} from '@/modules/quotes/quotes-columns';
import {
  type QuoteQueryState,
  type TablePreferenceConfig,
  type QuoteSegment,
  QUOTE_SEGMENTS,
  QUOTE_SEGMENT_LABELS,
} from '@/modules/quotes/quotes-filters';
import { type QuotesListResult, type QuoteListRow } from '@/modules/quotes/quotes-service';
import {
  formatCurrency,
  formatDateOnly,
  getQuoteStatusConfig,
  getQuoteStatusLabel,
  getQuoteStatusOptions,
  getQuoteExpiryInfo,
} from '@/modules/quotes/quotes-helpers';
import { QuotePreviewDrawer } from './QuotePreviewDrawer';
import type { CurrentUser } from '@/modules/auth/authorization';
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

export interface QuotesWorkspaceProps {
  user: CurrentUser;
  tableKey: string;
  entityLabel: string;
  entityLabelPlural: string;
  basePath: string;
  permissionView: string;
  permissionExport: string;
  permissionWatch: string;
  permissionShareViews: string;
  initialData: QuotesListResult;
  initialQuery: QuoteQueryState;
  preference: TablePreferenceConfig;
  views: { privateViews: TableViewRow[]; sharedViews: TableViewRow[] };
  defaultViewId: string | null;
  watchedIds: Set<string>;
  unreadNotifications: number;
  canExport: boolean;
  canWatch: boolean;
  canShareViews: boolean;
  canCreate: boolean;
  segmentCounts: Record<QuoteSegment, number>;
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
  if (!value) {
    return (
      <span className="so-status-cell">
        <span className="so-status-dot so-status-dot-muted" />
        <span className="text-muted">—</span>
      </span>
    );
  }
  const config = getQuoteStatusConfig(value);
  return (
    <span className="so-status-cell" title={`${label}: ${config.label}`}>
      <span className={`so-status-dot so-status-dot-${config.tone}`} />
      <span>{config.label}</span>
    </span>
  );
}

function ExpiryCell({ value, status }: { value: string | null; status: string | null }) {
  if (!value) return <>—</>;
  const info = getQuoteExpiryInfo(value, status);
  return (
    <span className="so-status-cell" title={info ? info.label : undefined}>
      {info ? <span className={`so-status-dot so-status-dot-${info.tone}`} /> : null}
      <span>{formatDateOnly(value)}</span>
      {info ? (
        <span style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)' }}>· {info.label}</span>
      ) : null}
    </span>
  );
}

function renderCell(row: QuoteListRow, column: EntityColumnDefinition): React.ReactNode {
  const value = (row as unknown as Record<string, unknown>)[column.id];
  const formatter = column.formatter as string | undefined;
  if (formatter === 'origin') {
    return (
      <span className={`badge ${row.createdInUnik ? 'badge-info' : 'badge-weak'}`}>
        {row.createdInUnik ? 'UNIK' : 'Zoho'}
      </span>
    );
  }
  if (value === null || value === undefined) return '—';
  if (formatter === 'currency') return formatCurrency(value as string | number, row.currencyCode);
  if (formatter === 'date') return formatDateOnly(value as string | Date);
  if (formatter === 'expiry') return <ExpiryCell value={value as string} status={row.status} />;
  if (formatter === 'statusDot')
    return <StatusCell value={value as string | null} label={column.label} />;
  return String(value);
}

function SegmentChips({
  basePath,
  current,
  counts,
}: {
  basePath: string;
  current: QuoteSegment;
  counts: Record<QuoteSegment, number>;
}) {
  return (
    <div className="so-segment-chips" role="tablist" aria-label="Segmentos de cotizaciones">
      {QUOTE_SEGMENTS.map((segment) => {
        const active = segment === current;
        const href = segment === 'all' ? basePath : `${basePath}?segment=${segment}`;
        return (
          <Link
            key={segment}
            href={href}
            role="tab"
            aria-selected={active}
            className={`so-segment-chip ${active ? 'so-segment-chip-active' : ''}`}
          >
            {QUOTE_SEGMENT_LABELS[segment]}
            <span className="so-segment-chip-count">{counts[segment] ?? 0}</span>
          </Link>
        );
      })}
    </div>
  );
}

export function QuotesWorkspace(props: QuotesWorkspaceProps) {
  const initialQuery: EntityQueryState = {
    ...props.initialQuery,
    search: props.initialQuery.search ?? '',
  } as unknown as EntityQueryState;
  const segment = props.initialQuery.segment ?? 'all';

  return (
    <EntityWorkspace<QuoteListRow>
      user={props.user}
      tableKey={props.tableKey}
      entityLabel={props.entityLabel}
      entityLabelPlural={props.entityLabelPlural}
      // Factura, Cotización, Orden de compra: femeninas.
      entityGender="f"
      basePath={props.basePath}
      permissionView={props.permissionView}
      permissionExport={props.permissionExport}
      permissionWatch={props.permissionWatch}
      permissionShareViews={props.permissionShareViews}
      initialData={props.initialData as unknown as EntityListResult<QuoteListRow>}
      initialQuery={initialQuery}
      preference={
        props.preference as unknown as import('@/modules/shared/entity-workspace-types').TablePreferenceConfig
      }
      views={props.views}
      defaultViewId={props.defaultViewId}
      watchedIds={props.watchedIds}
      unreadNotifications={props.unreadNotifications}
      canExport={props.canExport}
      canWatch={props.canWatch}
      canShareViews={props.canShareViews}
      initialSyncStatus={props.initialSyncStatus}
      columns={QUOTE_COLUMNS as unknown as EntityColumnDefinition[]}
      columnMap={QUOTE_COLUMN_MAP as unknown as Record<string, EntityColumnDefinition>}
      defaultColumnOrder={QUOTE_DEFAULT_COLUMN_ORDER}
      renderCell={renderCell}
      getStatusLabel={getQuoteStatusLabel}
      getStatusOptions={getQuoteStatusOptions}
      formatCurrency={formatCurrency}
      formatDateOnly={formatDateOnly}
      nameField="estimateNumber"
      searchPlaceholder="Buscar por folio, cliente, vendedor o producto..."
      savePreferenceAction={props.savePreferenceAction}
      resetPreferenceAction={props.resetPreferenceAction}
      createViewAction={props.createViewAction}
      watchAction={props.watchAction}
      unwatchAction={props.unwatchAction}
      bulkWatchAction={props.bulkWatchAction}
      exportAction={props.exportAction}
      extraUrlParams={segment !== 'all' ? { segment } : undefined}
      headerActions={
        props.canCreate ? (
          <Link href={`${props.basePath}/new`} className="btn btn-primary btn-sm">
            <Plus size={14} /> Nueva cotización
          </Link>
        ) : null
      }
      toolbarExtra={
        <SegmentChips basePath={props.basePath} current={segment} counts={props.segmentCounts} />
      }
      renderPreviewDrawer={({ entityId, ...rest }) => (
        <QuotePreviewDrawer quoteId={entityId} {...rest} />
      )}
    />
  );
}
