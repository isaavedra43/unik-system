'use client';

import Link from 'next/link';
import { ArrowLeft, Bell, BellRing, User } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';
import type { InvoiceDetail } from '@/modules/invoices/invoices-contract';
import {
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  formatNumber,
  getInvoiceStatusConfig,
} from '@/modules/invoices/invoices-helpers';
import type { RelatedContactSummary } from '@/modules/cross-module/relationships-service';

interface InvoiceDetailPageProps {
  invoice: InvoiceDetail;
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

export function InvoiceDetailPage({
  invoice,
  entityLabel,
  entityLabelPlural,
  basePath,
  isWatched: initialWatched,
  canWatch,
  watchAction,
  unwatchAction,
  relatedContact,
}: InvoiceDetailPageProps) {
  const [watched, setWatched] = useState(initialWatched);

  const handleWatch = async () => {
    if (!canWatch) return;
    const formData = new FormData();
    formData.set('entityId', invoice.id);
    const result = watched
      ? await unwatchAction({ error: null, success: false, isWatched: true }, formData)
      : await watchAction({ error: null, success: false, isWatched: false }, formData);
    if (result.success) {
      setWatched(!watched);
      toast.success(watched ? `Dejaste de seguir la ${entityLabel.toLowerCase()}` : `${entityLabel} seguida`);
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  const statusConfig = getInvoiceStatusConfig(invoice.status);

  const hasCfdi = Boolean(
    invoice.cfdiUuid ||
    invoice.cfdiVersion ||
    invoice.usoCfdi ||
    invoice.metodoPago ||
    invoice.formaPago ||
    invoice.regimenFiscal ||
    invoice.cfdiExportacion
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

        <div className="rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-2xl font-bold tracking-tight">{invoice.invoiceNumber ?? '—'}</h1>
              {invoice.customerName && <p className="text-sm text-muted-foreground">Cliente: {invoice.customerName}</p>}
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
          <DetailCard label="Fecha" value={invoice.date ? formatDateOnly(invoice.date) : '—'} />
          <DetailCard label="Vencimiento" value={invoice.dueDate ? formatDateOnly(invoice.dueDate) : '—'} />
          <DetailCard label="Cliente" value={invoice.customerName ?? '—'} />
          <DetailCard label="Vendedor" value={invoice.salespersonName ?? '—'} />
          <DetailCard label="Total" value={formatCurrency(invoice.total, invoice.currencyCode)} />
          <DetailCard label="Saldo" value={formatCurrency(invoice.balance, invoice.currencyCode)} />
          <DetailCard label="Moneda" value={invoice.currencyCode ?? '—'} />
          <DetailCard label="Subtotal" value={formatCurrency(invoice.subTotal, invoice.currencyCode)} />
          <DetailCard label="Impuestos" value={formatCurrency(invoice.taxTotal, invoice.currencyCode)} />
          <DetailCard label="Descuento" value={formatCurrency(invoice.discountTotal, invoice.currencyCode)} />
          <DetailCard label="Envío" value={formatCurrency(invoice.shippingCharge, invoice.currencyCode)} />
        </div>

        {hasCfdi && (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Datos CFDI</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <DetailCard label="UUID CFDI" value={invoice.cfdiUuid ?? '—'} />
              <DetailCard label="Versión CFDI" value={invoice.cfdiVersion ?? '—'} />
              <DetailCard label="Uso CFDI" value={invoice.usoCfdi ?? '—'} />
              <DetailCard label="Método de pago" value={invoice.metodoPago ?? '—'} />
              <DetailCard label="Forma de pago" value={invoice.formaPago ?? '—'} />
              <DetailCard label="Régimen fiscal" value={invoice.regimenFiscal ?? '—'} />
              <DetailCard label="Exportación CFDI" value={invoice.cfdiExportacion ?? '—'} />
            </div>
          </div>
        )}

        {invoice.items.length > 0 && (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Conceptos</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Producto</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Descripción</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide">Cantidad</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide">Precio</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide">Total</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Orden de venta</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.items.map((item) => (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="px-3 py-2">{item.name ?? '—'}</td>
                      <td className="px-3 py-2 text-muted-foreground">{item.description ?? '—'}</td>
                      <td className="px-3 py-2 text-right">{formatNumber(item.quantity)}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(item.rate, invoice.currencyCode)}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(item.lineTotal, invoice.currencyCode)}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {item.zohoSalesOrderId ? (
                          <Link href={`/app/sales/orders/${item.zohoSalesOrderId}`} className="text-primary hover:underline">
                            {item.zohoSalesOrderId}
                          </Link>
                        ) : '—'}
                      </td>
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
            <DetailCard label="Última modificación remota" value={formatDateTime(invoice.sourceRemoteModifiedAt)} />
            <DetailCard label="Última normalización" value={formatDateTime(invoice.normalizedAt)} />
            <DetailCard label="ID Zoho" value={invoice.zohoInvoiceId} />
            <DetailCard label="ID Snapshot" value={invoice.sourceSnapshotId} />
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
