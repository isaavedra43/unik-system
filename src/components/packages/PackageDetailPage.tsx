'use client';

import Link from 'next/link';
import { ArrowLeft, Bell, BellRing, User, ShoppingCart, FileText, MapPin, Package } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';
import type { PackageDetail } from '@/modules/packages/packages-contract';
import {
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  formatNumber,
  getPackageStatusConfig,
} from '@/modules/packages/packages-helpers';
import type { RelatedContactSummary } from '@/modules/cross-module/relationships-service';

interface RelatedSalesOrderSummary {
  id: string;
  salesOrderNumber: string | null;
  status: string | null;
  total: string | null;
}

interface RelatedInvoiceSummary {
  id: string;
  invoiceNumber: string | null;
  status: string | null;
  total: string | null;
  date: string | null;
}

interface PackageDetailPageProps {
  pkg: PackageDetail;
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
  relatedContact?: RelatedContactSummary | null;
  relatedSalesOrder?: RelatedSalesOrderSummary | null;
  relatedInvoices?: RelatedInvoiceSummary[];
}

export function PackageDetailPage({
  pkg,
  entityLabel,
  entityLabelPlural,
  basePath,
  isWatched: initialWatched,
  canWatch,
  watchAction,
  unwatchAction,
  relatedContact,
  relatedSalesOrder,
  relatedInvoices,
}: PackageDetailPageProps) {
  const [watched, setWatched] = useState(initialWatched);

  const handleWatch = async () => {
    if (!canWatch) return;
    const formData = new FormData();
    formData.set('entityId', pkg.id);
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

  const statusConfig = getPackageStatusConfig(pkg.status);
  const hasShippingAddress = Boolean(
    pkg.shippingAddress || pkg.shippingCity || pkg.shippingState || pkg.shippingCountry || pkg.shippingAttention
  );

  return (
    <div className="app-content">
      <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6 lg:p-8">
        <div className="flex items-center justify-between gap-4">
          <Link href={basePath} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" />
            Volver a {entityLabelPlural.toLowerCase()}
          </Link>
          {canWatch && (
            <button onClick={handleWatch} className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent transition-colors">
              {watched ? <><BellRing className="h-4 w-4 text-primary" />Siguiendo</> : <><Bell className="h-4 w-4" />Seguir</>}
            </button>
          )}
        </div>

        {/* Header */}
        <div className="rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-2xl font-bold tracking-tight">{pkg.packageNumber ?? '—'}</h1>
              {pkg.trackingNumber && <p className="text-sm text-muted-foreground">Guía: {pkg.trackingNumber}</p>}
              {pkg.salesorderNumber && <p className="text-sm text-muted-foreground">Folio OV: {pkg.salesorderNumber}</p>}
            </div>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
              statusConfig.tone === 'success' ? 'bg-success/10 text-success'
              : statusConfig.tone === 'danger' ? 'bg-destructive/10 text-destructive'
              : statusConfig.tone === 'warning' ? 'bg-warning/10 text-warning'
              : statusConfig.tone === 'info' ? 'bg-info/10 text-info'
              : 'bg-muted text-muted-foreground'
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${
                statusConfig.tone === 'success' ? 'bg-success'
                : statusConfig.tone === 'danger' ? 'bg-destructive'
                : statusConfig.tone === 'warning' ? 'bg-warning'
                : statusConfig.tone === 'info' ? 'bg-info'
                : 'bg-muted-foreground'
              }`} />
              {statusConfig.label}
            </span>
          </div>
        </div>

        {/* General info */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DetailCard label="Fecha" value={pkg.date ? formatDateOnly(pkg.date) : '—'} />
          <DetailCard label="Cliente" value={pkg.customerName ?? '—'} />
          <DetailCard label="Paquetería" value={pkg.carrier ?? '—'} />
          <DetailCard label="Tipo de envío" value={pkg.shipmentType ?? '—'} />
          <DetailCard label="Método de entrega" value={pkg.deliveryMethod ?? '—'} />
          <DetailCard label="Costo de envío" value={formatCurrency(pkg.shippingCharge)} />
          {pkg.shipmentDate && <DetailCard label="Fecha de envío" value={formatDateOnly(pkg.shipmentDate)} />}
          {pkg.shipmentStatus && <DetailCard label="Estado de envío" value={pkg.shipmentStatus} />}
          {pkg.salesChannel && <DetailCard label="Canal de venta" value={pkg.salesChannel} />}
          {pkg.quantity && <DetailCard label="Cantidad total" value={pkg.quantity} />}
        </div>

        {/* Customer info */}
        {relatedContact && (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2"><User className="h-4 w-4" /> Cliente</h2>
            <Link
              href={relatedContact.contactType === 'vendor' ? `/app/contacts/vendors/${relatedContact.id}` : `/app/contacts/customers/${relatedContact.id}`}
              className="inline-flex items-center justify-between w-full rounded-md border border-input bg-background px-4 py-2.5 text-sm hover:bg-accent transition-colors"
            >
              <span className="font-medium">{relatedContact.contactName ?? relatedContact.companyName ?? '—'}</span>
              <span className="text-muted-foreground text-xs">{relatedContact.contactType ?? '—'}</span>
            </Link>
            {pkg.shippingPhone && (
              <p className="text-sm text-muted-foreground">Teléfono: {pkg.shippingPhone}</p>
            )}
          </div>
        )}

        {/* Shipping address */}
        {hasShippingAddress ? (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2"><MapPin className="h-4 w-4" /> Dirección de envío</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {pkg.shippingAttention && <DetailCard label="Contacto para recepción" value={pkg.shippingAttention} />}
              <DetailCard label="Calle" value={pkg.shippingAddress ?? '—'} />
              <DetailCard label="Ciudad" value={pkg.shippingCity ?? '—'} />
              <DetailCard label="Estado" value={pkg.shippingState ?? '—'} />
              <DetailCard label="C.P." value={pkg.shippingZip ?? '—'} />
              <DetailCard label="País" value={pkg.shippingCountry ?? '—'} />
              {pkg.shippingPhone && <DetailCard label="Teléfono" value={pkg.shippingPhone} />}
            </div>
          </div>
        ) : (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2"><MapPin className="h-4 w-4" /> Dirección de envío</h2>
            <p className="text-sm text-muted-foreground">
              No hay dirección de envío disponible. Ejecuta la sincronización para obtener los detalles completos del paquete.
            </p>
          </div>
        )}

        {/* Package items / materials */}
        {pkg.items.length > 0 ? (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2"><Package className="h-4 w-4" /> Contenido del paquete ({pkg.items.length})</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">#</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Artículo & Descripción</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Código</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide">Cantidad</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Unidad</th>
                  </tr>
                </thead>
                <tbody>
                  {pkg.items.map((item, index) => (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="px-3 py-2 text-muted-foreground">{index + 1}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{item.name ?? '—'}</div>
                        {item.description && (
                          <div className="text-xs text-muted-foreground mt-0.5">{item.description}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{item.sku ?? '—'}</td>
                      <td className="px-3 py-2 text-right font-medium">{formatNumber(item.quantity)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{item.unit ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2"><Package className="h-4 w-4" /> Contenido del paquete</h2>
            <p className="text-sm text-muted-foreground">
              No hay items disponibles. Ejecuta la sincronización para obtener los detalles completos del paquete desde Zoho.
            </p>
          </div>
        )}

        {/* Related sales order */}
        {relatedSalesOrder && (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2"><ShoppingCart className="h-4 w-4" /> Orden de venta relacionada</h2>
            <Link
              href={`/app/sales/orders/${relatedSalesOrder.id}`}
              className="inline-flex items-center justify-between w-full rounded-md border border-input bg-background px-4 py-2.5 text-sm hover:bg-accent transition-colors"
            >
              <span className="font-medium">{relatedSalesOrder.salesOrderNumber ?? '—'}</span>
              <span className="text-muted-foreground text-xs">
                {relatedSalesOrder.status ?? '—'} · {relatedSalesOrder.total ? formatCurrency(relatedSalesOrder.total, null) : '—'}
              </span>
            </Link>
          </div>
        )}

        {/* Related invoices */}
        {relatedInvoices && relatedInvoices.length > 0 && (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2"><FileText className="h-4 w-4" /> Facturas relacionadas ({relatedInvoices.length})</h2>
            <div className="flex flex-col gap-2">
              {relatedInvoices.map((inv) => (
                <Link
                  key={inv.id}
                  href={`/app/invoices/${inv.id}`}
                  className="inline-flex items-center justify-between w-full rounded-md border border-input bg-background px-4 py-2.5 text-sm hover:bg-accent transition-colors"
                >
                  <span className="font-medium">{inv.invoiceNumber ?? '—'}</span>
                  <span className="text-muted-foreground text-xs">
                    {inv.status ?? '—'} · {inv.total ? formatCurrency(inv.total, null) : '—'}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Sync info */}
        <div className="rounded-lg border bg-card p-6 space-y-3">
          <h2 className="text-lg font-semibold">Sincronización</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <DetailCard label="Última modificación remota" value={formatDateTime(pkg.sourceRemoteModifiedAt)} />
            <DetailCard label="Última normalización" value={formatDateTime(pkg.normalizedAt)} />
            <DetailCard label="ID Zoho" value={pkg.zohoPackageId} />
            <DetailCard label="ID Snapshot" value={pkg.sourceSnapshotId} />
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
