'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellRing, ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';
import { CurrentUser } from '@/modules/auth/authorization';
import {
  EntityWorkspace,
  type EntityWorkspaceProps,
} from '@/components/common/EntityWorkspace';
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
import type {
  PurchaseOrderListRow,
  PurchaseOrderDetail,
} from '@/modules/purchase-orders/purchase-orders-contract';
import {
  formatCurrency,
  formatDateOnly,
  formatDateTime,
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

interface PreviewDrawerProps {
  entityId: string;
  basePath: string;
  entityLabel: string;
  onClose: () => void;
  canWatch: boolean;
  isWatched: boolean;
  onWatchChange: (watched: boolean) => void;
  watchAction: WatchAction;
  unwatchAction: WatchAction;
}

function PurchaseOrderPreviewDrawer({
  entityId,
  basePath,
  entityLabel,
  onClose,
  canWatch,
  isWatched,
  onWatchChange,
  watchAction,
  unwatchAction,
}: PreviewDrawerProps) {
  const router = useRouter();
  const [purchaseOrder, setPurchaseOrder] = useState<PurchaseOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [watched, setWatched] = useState(isWatched);

  useEffect(() => {
    setWatched(isWatched);
  }, [isWatched]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${basePath}/${entityId}/api`);
        if (!res.ok) throw new Error('No se pudo cargar la orden de compra');
        const json = (await res.json()) as PurchaseOrderDetail;
        if (!cancelled) {
          setPurchaseOrder(json);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Error');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [entityId, basePath]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const handleWatch = async () => {
    if (!canWatch) return;
    const formData = new FormData();
    formData.set('entityId', entityId);
    const result = watched
      ? await unwatchAction({ error: null, success: false, isWatched: true }, formData)
      : await watchAction({ error: null, success: false, isWatched: false }, formData);
    if (result.success) {
      setWatched(!watched);
      onWatchChange(!watched);
      toast.success(watched ? `Dejaste de seguir la ${entityLabel.toLowerCase()}` : `${entityLabel} seguida`);
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  const statusConfig = purchaseOrder ? getPurchaseOrderStatusConfig(purchaseOrder.status) : null;

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Cerrar"
      />
      <div className="relative ml-auto h-full w-full max-w-md bg-background shadow-xl overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-4 py-3">
          <h2 className="text-sm font-semibold truncate">{entityLabel}</h2>
          <div className="flex items-center gap-1">
            {canWatch && (
              <button
                onClick={handleWatch}
                className="inline-flex items-center justify-center rounded-md p-1.5 hover:bg-accent transition-colors"
                aria-label={watched ? 'Dejar de seguir' : 'Seguir'}
              >
                {watched ? <BellRing className="h-4 w-4 text-primary" /> : <Bell className="h-4 w-4" />}
              </button>
            )}
            <button
              onClick={() => router.push(`${basePath}/${entityId}`)}
              className="inline-flex items-center justify-center rounded-md p-1.5 hover:bg-accent transition-colors"
              aria-label="Abrir página completa"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              className="inline-flex items-center justify-center rounded-md p-1.5 hover:bg-accent transition-colors"
              aria-label="Cerrar"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
              {error}
            </div>
          )}

          {purchaseOrder && !loading && (
            <>
              <div className="space-y-1">
                <h3 className="text-lg font-bold">{purchaseOrder.purchaseOrderNumber ?? '—'}</h3>
                {purchaseOrder.vendorName && (
                  <p className="text-sm text-muted-foreground">{purchaseOrder.vendorName}</p>
                )}
                {statusConfig && (
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      statusConfig.tone === 'success'
                        ? 'bg-success/10 text-success'
                        : statusConfig.tone === 'danger'
                          ? 'bg-destructive/10 text-destructive'
                          : statusConfig.tone === 'warning'
                            ? 'bg-warning/10 text-warning'
                            : statusConfig.tone === 'info'
                              ? 'bg-info/10 text-info'
                              : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        statusConfig.tone === 'success'
                          ? 'bg-success'
                          : statusConfig.tone === 'danger'
                            ? 'bg-destructive'
                            : statusConfig.tone === 'warning'
                              ? 'bg-warning'
                              : statusConfig.tone === 'info'
                                ? 'bg-info'
                                : 'bg-muted-foreground'
                      }`}
                    />
                    {statusConfig.label}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <PreviewField label="Fecha" value={formatDateOnly(purchaseOrder.date)} />
                <PreviewField label="Vencimiento" value={formatDateOnly(purchaseOrder.dueDate)} />
                <PreviewField label="Entrega" value={formatDateOnly(purchaseOrder.deliveryDate)} />
                <PreviewField label="Proveedor" value={purchaseOrder.vendorName ?? '—'} />
                <PreviewField label="Moneda" value={purchaseOrder.currencyCode ?? '—'} />
                <PreviewField label="Subtotal" value={formatCurrency(purchaseOrder.subTotal, purchaseOrder.currencyCode)} />
                <PreviewField label="Impuestos" value={formatCurrency(purchaseOrder.taxTotal, purchaseOrder.currencyCode)} />
                <PreviewField label="Descuento" value={formatCurrency(purchaseOrder.discountTotal, purchaseOrder.currencyCode)} />
                <PreviewField label="Envío" value={formatCurrency(purchaseOrder.shippingCharge, purchaseOrder.currencyCode)} />
                <PreviewField label="Total" value={formatCurrency(purchaseOrder.total, purchaseOrder.currencyCode)} />
                <PreviewField label="Saldo" value={formatCurrency(purchaseOrder.balance, purchaseOrder.currencyCode)} />
                <PreviewField label="Vendedor" value={purchaseOrder.salespersonName ?? '—'} />
                <PreviewField label="Referencia" value={purchaseOrder.referenceNumber ?? '—'} />
              </div>

              {purchaseOrder.notes && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Notas</p>
                  <p className="text-sm whitespace-pre-wrap text-muted-foreground">{purchaseOrder.notes}</p>
                </div>
              )}

              {purchaseOrder.items.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">
                    Conceptos ({purchaseOrder.items.length})
                  </p>
                  <div className="space-y-2">
                    {purchaseOrder.items.map((item) => (
                      <div key={item.id} className="rounded-md border p-2.5 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium truncate">{item.name ?? '—'}</span>
                          <span className="text-muted-foreground whitespace-nowrap">
                            {formatCurrency(item.lineTotal, purchaseOrder.currencyCode)}
                          </span>
                        </div>
                        {item.description && (
                          <p className="text-xs text-muted-foreground mt-1">{item.description}</p>
                        )}
                        <p className="text-xs text-muted-foreground mt-1">
                          {item.quantity ?? '—'} {item.unit ?? ''} × {formatCurrency(item.rate, purchaseOrder.currencyCode)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-1 border-t pt-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Sincronización</p>
                <p className="text-xs text-muted-foreground">
                  Últ. modificación remota: {formatDateTime(purchaseOrder.sourceRemoteModifiedAt)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Últ. normalización: {formatDateTime(purchaseOrder.normalizedAt)}
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium truncate">{value}</p>
    </div>
  );
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
