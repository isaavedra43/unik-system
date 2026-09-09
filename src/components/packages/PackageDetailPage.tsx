'use client';

import Link from 'next/link';
import { ArrowLeft, Bell, BellRing, User } from 'lucide-react';
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

        <div className="rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-2xl font-bold tracking-tight">{pkg.packageNumber ?? '—'}</h1>
              {pkg.trackingNumber && <p className="text-sm text-muted-foreground">Guía: {pkg.trackingNumber}</p>}
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
          {pkg.isCarrierShipment !== null && <DetailCard label="Envío por paquetería" value={pkg.isCarrierShipment ? 'Sí' : 'No'} />}
          {pkg.isTrackingEnabled !== null && <DetailCard label="Rastreo habilitado" value={pkg.isTrackingEnabled ? 'Sí' : 'No'} />}
          {pkg.labelFormat && <DetailCard label="Formato de etiqueta" value={pkg.labelFormat} />}
          {pkg.zohoSalesOrderId && <DetailCard label="Orden de venta Zoho" value={pkg.zohoSalesOrderId} />}
          {pkg.salesorderNumber && <DetailCard label="Folio OV" value={pkg.salesorderNumber} />}
          {pkg.zohoCustomerId && <DetailCard label="Cliente Zoho" value={pkg.zohoCustomerId} />}
        </div>

        {/* Shipping address */}
        {(pkg.shippingAddress || pkg.shippingCity || pkg.shippingState || pkg.shippingCountry) ? (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Dirección de envío</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {pkg.shippingAttention && <DetailCard label="Atención" value={pkg.shippingAttention} />}
              <DetailCard label="Calle" value={pkg.shippingAddress ?? '—'} />
              <DetailCard label="Ciudad" value={pkg.shippingCity ?? '—'} />
              <DetailCard label="Estado" value={pkg.shippingState ?? '—'} />
              <DetailCard label="C.P." value={pkg.shippingZip ?? '—'} />
              <DetailCard label="País" value={pkg.shippingCountry ?? '—'} />
              <DetailCard label="Teléfono" value={pkg.shippingPhone ?? '—'} />
            </div>
          </div>
        ) : null}

        {pkg.items.length > 0 && (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Contenido del paquete</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Producto</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">SKU</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide">Cantidad</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Unidad</th>
                  </tr>
                </thead>
                <tbody>
                  {pkg.items.map((item) => (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="px-3 py-2">{item.name ?? '—'}</td>
                      <td className="px-3 py-2 text-muted-foreground">{item.sku ?? '—'}</td>
                      <td className="px-3 py-2 text-right">{formatNumber(item.quantity)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{item.unit ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="rounded-lg border bg-card p-6 space-y-3">
          <h2 className="text-lg font-semibold">Sincronización</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <DetailCard label="Última modificación remota" value={formatDateTime(pkg.sourceRemoteModifiedAt)} />
            <DetailCard label="Última normalización" value={formatDateTime(pkg.normalizedAt)} />
            <DetailCard label="ID Zoho" value={pkg.zohoPackageId} />
            <DetailCard label="ID Snapshot" value={pkg.sourceSnapshotId} />
          </div>
        </div>

        {relatedContact && (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2"><User className="h-4 w-4" /> Contacto relacionado</h2>
            <Link
              href={relatedContact.contactType === 'vendor' ? `/app/contacts/vendors/${relatedContact.id}` : `/app/contacts/customers/${relatedContact.id}`}
              className="inline-flex items-center justify-between w-full rounded-md border border-input bg-background px-4 py-2.5 text-sm hover:bg-accent transition-colors"
            >
              <span className="font-medium">{relatedContact.contactName ?? relatedContact.companyName ?? '—'}</span>
              <span className="text-muted-foreground text-xs">{relatedContact.contactType ?? '—'}</span>
            </Link>
          </div>
        )}
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
