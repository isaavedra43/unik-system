'use client';

import Link from 'next/link';
import { ArrowLeft, Bell, BellRing } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';
import type { ProductDetail } from '@/modules/products/products-contract';
import {
  formatCurrency,
  formatDateTime,
  formatNumber,
  getProductStatusConfig,
} from '@/modules/products/products-helpers';
import type { ProductTransactionHistoryRow } from '@/modules/cross-module/relationships-service';

interface ProductDetailPageProps {
  product: ProductDetail;
  entityLabel: string;
  entityLabelPlural: string;
  basePath: string;
  isWatched: boolean;
  canWatch: boolean;
  watchAction: (
    prevState: { error: string | null; success: boolean; isWatched: boolean },
    formData: FormData
  ) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;
  unwatchAction: (
    prevState: { error: string | null; success: boolean; isWatched: boolean },
    formData: FormData
  ) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;
  salesOrderHistory?: ProductTransactionHistoryRow[];
  invoiceHistory?: ProductTransactionHistoryRow[];
  packageHistory?: ProductTransactionHistoryRow[];
  vendorId?: string | null;
  vendorName?: string | null;
}

export function ProductDetailPage({
  product,
  entityLabel,
  entityLabelPlural,
  basePath,
  isWatched: initialWatched,
  canWatch,
  watchAction,
  unwatchAction,
  salesOrderHistory,
  invoiceHistory,
  packageHistory,
  vendorId,
  vendorName,
}: ProductDetailPageProps) {
  const [watched, setWatched] = useState(initialWatched);

  const handleWatch = async () => {
    if (!canWatch) return;
    const formData = new FormData();
    formData.set('entityId', product.id);
    const result = watched
      ? await unwatchAction({ error: null, success: false, isWatched: true }, formData)
      : await watchAction({ error: null, success: false, isWatched: false }, formData);
    if (result.success) {
      setWatched(!watched);
      toast.success(watched ? `Dejaste de seguir el ${entityLabel.toLowerCase()}` : `${entityLabel} seguido`);
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  const statusConfig = getProductStatusConfig(product.status);

  return (
    <div className="app-content">
      <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6 lg:p-8">
        <div className="flex items-center justify-between gap-4">
          <Link
            href={basePath}
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Volver a {entityLabelPlural.toLowerCase()}
          </Link>
          {canWatch && (
            <button
              onClick={handleWatch}
              className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent transition-colors"
            >
              {watched ? (
                <>
                  <BellRing className="h-4 w-4 text-primary" />
                  Siguiendo
                </>
              ) : (
                <>
                  <Bell className="h-4 w-4" />
                  Seguir
                </>
              )}
            </button>
          )}
        </div>

        <div className="rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-2xl font-bold tracking-tight">{product.name ?? '—'}</h1>
              <p className="text-sm text-muted-foreground">SKU: {product.sku ?? '—'}</p>
            </div>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                statusConfig.tone === 'success'
                  ? 'bg-success/10 text-success'
                  : statusConfig.tone === 'danger'
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${
                statusConfig.tone === 'success' ? 'bg-success' : statusConfig.tone === 'danger' ? 'bg-destructive' : 'bg-muted-foreground'
              }`} />
              {statusConfig.label}
            </span>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DetailCard label="Precio" value={formatCurrency(product.rate, product.currencyCode)} />
          <DetailCard label="Costo de compra" value={formatCurrency(product.purchaseRate, product.currencyCode)} />
          <DetailCard label="Tipo" value={product.productType ?? '—'} />
          <DetailCard label="Categoría" value={product.categoryName ?? '—'} />
          <DetailCard label="Marca" value={product.brand ?? '—'} />
          <DetailCard label="Fabricante" value={product.manufacturer ?? '—'} />
          <DetailCard label="Unidad" value={product.unit ?? '—'} />
          <DetailCard label="Stock disponible" value={formatNumber(product.availableStock)} />
          <DetailCard label="Stock total" value={formatNumber(product.stockOnHand)} />
          <DetailCard label="Punto de reorden" value={formatNumber(product.reorderLevel)} />
          <DetailCard label="Gravable" value={product.isTaxable === null ? '—' : product.isTaxable ? 'Sí' : 'No'} />
          <DetailCard label="Impuesto" value={product.taxName ? `${product.taxName} (${product.taxPercentage ?? '0'}%)` : '—'} />
        </div>

        {/* Additional Zoho fields */}
        <div className="rounded-lg border bg-card p-6 space-y-3">
          <h2 className="text-lg font-semibold">Detalles Zoho</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <DetailCard label="Tipo de item" value={product.itemType ?? '—'} />
            <DetailCard label="Origen" value={product.source ?? '—'} />
            <DetailCard label="Preferencia de impuesto" value={product.taxPreference ?? '—'} />
            <DetailCard label="Impuesto de compra" value={product.purchaseTaxName ?? '—'} />
            <DetailCard label="Cuenta de compra" value={product.purchaseAccountName ?? '—'} />
            <DetailCard label="Cuenta de venta" value={product.salesAccountName ?? '—'} />
            <DetailCard label="Cuenta de inventario" value={product.inventoryAccountName ?? '—'} />
            <DetailCard label="Método de valoración" value={product.inventoryValuationMethod ?? '—'} />
            <DetailCard label="Creado en Zoho" value={product.zohoCreatedTime ? formatDateTime(product.zohoCreatedTime) : '—'} />
            <DetailCard label="Modificado en Zoho" value={product.zohoLastModifiedTime ? formatDateTime(product.zohoLastModifiedTime) : '—'} />
          </div>
        </div>

        {/* Vendor link */}
        {vendorId && vendorName ? (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Proveedor</h2>
            <Link
              href={`/app/contacts/vendors/${vendorId}`}
              className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
            >
              {vendorName}
            </Link>
          </div>
        ) : null}

        <div className="rounded-lg border bg-card p-6 space-y-3">
          <h2 className="text-lg font-semibold">Campos fiscales México (SAT)</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <DetailCard label="Código de producto SAT" value={product.satProductCode ?? '—'} />
            <DetailCard label="Clave de unidad SAT" value={product.satUnitCode ?? '—'} />
          </div>
        </div>

        {product.description && (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Descripción</h2>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{product.description}</p>
          </div>
        )}

        {/* Transaction history */}
        {salesOrderHistory && salesOrderHistory.length > 0 ? (
          <TransactionHistoryTable title="Historial en órdenes de venta" rows={salesOrderHistory} />
        ) : null}
        {invoiceHistory && invoiceHistory.length > 0 ? (
          <TransactionHistoryTable title="Historial en facturas" rows={invoiceHistory} />
        ) : null}
        {packageHistory && packageHistory.length > 0 ? (
          <TransactionHistoryTable title="Historial en paquetes" rows={packageHistory} />
        ) : null}

        <div className="rounded-lg border bg-card p-6 space-y-3">
          <h2 className="text-lg font-semibold">Sincronización</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <DetailCard label="Última modificación remota" value={formatDateTime(product.sourceRemoteModifiedAt)} />
            <DetailCard label="Última normalización" value={formatDateTime(product.normalizedAt)} />
            <DetailCard label="ID Zoho" value={product.zohoItemId} />
            <DetailCard label="ID Snapshot" value={product.sourceSnapshotId} />
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-4 space-y-1">
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-sm font-medium truncate">{value}</p>
    </div>
  );
}

function TransactionHistoryTable({ title, rows }: { title: string; rows: ProductTransactionHistoryRow[] }) {
  return (
    <div className="rounded-lg border bg-card p-6 space-y-3">
      <h2 className="text-lg font-semibold">{title} ({rows.length})</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground uppercase">
              <th className="py-2 pr-4">Fecha</th>
              <th className="py-2 pr-4">Documento</th>
              <th className="py-2 pr-4">Cliente</th>
              <th className="py-2 pr-4 text-right">Cantidad</th>
              <th className="py-2 pr-4 text-right">Precio</th>
              <th className="py-2 pr-4 text-right">Total</th>
              <th className="py-2 pr-4">Estado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b last:border-0">
                <td className="py-2 pr-4">{row.date ? new Date(row.date).toLocaleDateString() : '—'}</td>
                <td className="py-2 pr-4">
                  <Link
                    href={
                      row.documentType === 'sales_order'
                        ? `/app/sales/orders/${row.documentId}`
                        : row.documentType === 'invoice'
                          ? `/app/invoices/${row.documentId}`
                          : `/app/packages/${row.documentId}`
                    }
                    className="text-primary hover:underline"
                  >
                    {row.documentNumber ?? '—'}
                  </Link>
                </td>
                <td className="py-2 pr-4">{row.customerName ?? '—'}</td>
                <td className="py-2 pr-4 text-right">{row.quantity ?? '—'}</td>
                <td className="py-2 pr-4 text-right">{row.rate ? formatCurrency(row.rate, null) : '—'}</td>
                <td className="py-2 pr-4 text-right">{row.total ? formatCurrency(row.total, null) : '—'}</td>
                <td className="py-2 pr-4">{row.status ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
