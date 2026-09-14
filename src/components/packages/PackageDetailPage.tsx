'use client';

import Link from 'next/link';
import {
  ArrowLeft,
  Bell,
  BellRing,
  FileText,
  MapPin,
  ShoppingCart,
  Truck,
  User,
} from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';
import type { PackageDetail } from '@/modules/packages/packages-contract';
import {
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  formatNumber,
} from '@/modules/packages/packages-helpers';
import { getSalesOrderStatusConfig } from '@/modules/sales/sales-orders-helpers';
import type { RelatedContactSummary } from '@/modules/cross-module/relationships-service';
import {
  PackageAddress,
  PackageItemsTable,
  PackagePdfActions,
  PackageShipmentFacts,
  PackageStatusBadge,
  PackageSteps,
  RelatedLink,
} from './package-view';

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

type WatchAction = (
  prevState: { error: string | null; success: boolean; isWatched: boolean },
  formData: FormData
) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;

interface PackageDetailPageProps {
  pkg: PackageDetail;
  entityLabel: string;
  entityLabelPlural: string;
  basePath: string;
  isWatched: boolean;
  canWatch: boolean;
  watchAction: WatchAction;
  unwatchAction: WatchAction;
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
  const [watchBusy, setWatchBusy] = useState(false);

  const handleWatch = async () => {
    if (!canWatch || watchBusy) return;
    setWatchBusy(true);
    const formData = new FormData();
    formData.set('entityId', pkg.id);
    const result = watched
      ? await unwatchAction({ error: null, success: false, isWatched: true }, formData)
      : await watchAction({ error: null, success: false, isWatched: false }, formData);
    setWatchBusy(false);
    if (result.success) {
      setWatched(!watched);
      toast.success(
        watched ? `Dejaste de seguir el ${entityLabel.toLowerCase()}` : `${entityLabel} seguido`
      );
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  const salesOrderNumber = relatedSalesOrder?.salesOrderNumber ?? pkg.salesorderNumber;
  const totalQty =
    pkg.quantity ??
    (pkg.items.length ? String(pkg.items.reduce((s, i) => s + Number(i.quantity ?? 0), 0)) : null);
  const customerHref = relatedContact?.id ? `/app/contacts/customers/${relatedContact.id}` : null;

  return (
    <div className="app-content pkg-page">
      <div className="pkg-topbar">
        <Link href={basePath} className="pkg-back">
          <ArrowLeft size={14} aria-hidden="true" />
          Volver a {entityLabelPlural.toLowerCase()}
        </Link>
        <div className="pkg-topbar-actions">
          {canWatch ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleWatch}
              aria-pressed={watched}
              disabled={watchBusy}
            >
              {watched ? (
                <BellRing size={14} aria-hidden="true" />
              ) : (
                <Bell size={14} aria-hidden="true" />
              )}
              {watched ? 'Siguiendo' : 'Seguir'}
            </button>
          ) : null}
          <PackagePdfActions pkgId={pkg.id} basePath={basePath} />
        </div>
      </div>

      <header className="card pkg-hero">
        <div className="pkg-hero-row">
          <div className="pkg-hero-main">
            <p className="pkg-kicker">
              {entityLabel}
              {salesOrderNumber ? (
                <>
                  {' · '}
                  {relatedSalesOrder ? (
                    <Link href={`/app/sales/orders/${relatedSalesOrder.id}`} className="pkg-link">
                      {salesOrderNumber}
                    </Link>
                  ) : (
                    salesOrderNumber
                  )}
                </>
              ) : null}
            </p>
            <h1 className="pkg-title">{pkg.packageNumber ?? '—'}</h1>
            <p className="pkg-hero-sub">
              {customerHref ? (
                <Link href={customerHref} className="pkg-link">
                  {pkg.customerName ?? relatedContact?.contactName ?? 'Cliente'}
                </Link>
              ) : (
                <span>{pkg.customerName ?? 'Cliente no especificado'}</span>
              )}
              <span aria-hidden="true">·</span>
              <span>{formatDateOnly(pkg.date)}</span>
              {totalQty ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {formatNumber(totalQty)} {pkg.items[0]?.unit ?? 'unidades'}
                  </span>
                </>
              ) : null}
            </p>
          </div>
          <PackageStatusBadge status={pkg.status} className="pkg-hero-badge" />
        </div>
        <PackageSteps pkg={pkg} />
      </header>

      <div className="pkg-grid">
        <div className="pkg-main">
          <section className="card pkg-card">
            <div className="pkg-card-head">
              <h2 className="pkg-card-title">Contenido del paquete</h2>
              {pkg.items.length > 0 ? (
                <span className="pkg-count">
                  {pkg.items.length} {pkg.items.length === 1 ? 'artículo' : 'artículos'}
                </span>
              ) : null}
            </div>
            <PackageItemsTable pkg={pkg} />
          </section>

          {relatedInvoices && relatedInvoices.length > 0 ? (
            <section className="card pkg-card">
              <div className="pkg-card-head">
                <h2 className="pkg-card-title">
                  <FileText size={15} aria-hidden="true" /> Facturas relacionadas
                </h2>
                <span className="pkg-count">{relatedInvoices.length}</span>
              </div>
              <div className="pkg-related-list">
                {relatedInvoices.map((inv) => (
                  <RelatedLink
                    key={inv.id}
                    href={`/app/invoices/${inv.id}`}
                    title={inv.invoiceNumber ?? '—'}
                    meta={[
                      inv.status,
                      inv.total ? formatCurrency(inv.total, null) : null,
                      inv.date ? formatDateOnly(inv.date) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <aside className="pkg-side">
          <section className="card pkg-card">
            <div className="pkg-card-head">
              <h2 className="pkg-card-title">
                <Truck size={15} aria-hidden="true" /> Envío
              </h2>
            </div>
            <PackageShipmentFacts pkg={pkg} />
          </section>

          <section className="card pkg-card">
            <div className="pkg-card-head">
              <h2 className="pkg-card-title">
                <User size={15} aria-hidden="true" /> Cliente
              </h2>
              {relatedContact?.contactType ? (
                <span className="badge badge-weak">{relatedContact.contactType}</span>
              ) : null}
            </div>
            <div className="pkg-customer">
              {customerHref ? (
                <Link href={customerHref} className="pkg-link pkg-customer-name">
                  {relatedContact?.contactName ?? pkg.customerName ?? '—'}
                </Link>
              ) : (
                <strong className="pkg-customer-name">{pkg.customerName ?? '—'}</strong>
              )}
              {relatedContact?.companyName &&
              relatedContact.companyName !== relatedContact.contactName ? (
                <span className="text-muted">{relatedContact.companyName}</span>
              ) : null}
            </div>
            <h3 className="pkg-subhead">
              <MapPin size={13} aria-hidden="true" /> Dirección de envío
            </h3>
            <PackageAddress pkg={pkg} />
          </section>

          {relatedSalesOrder ? (
            <section className="card pkg-card">
              <div className="pkg-card-head">
                <h2 className="pkg-card-title">
                  <ShoppingCart size={15} aria-hidden="true" /> Orden de venta
                </h2>
              </div>
              <RelatedLink
                href={`/app/sales/orders/${relatedSalesOrder.id}`}
                title={relatedSalesOrder.salesOrderNumber ?? '—'}
                meta={[
                  getSalesOrderStatusConfig(relatedSalesOrder.status, 'order').label,
                  relatedSalesOrder.total ? formatCurrency(relatedSalesOrder.total, null) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            </section>
          ) : null}
        </aside>
      </div>

      <footer className="pkg-sync">
        <span>Datos de Zoho Inventory</span>
        <span>Última modificación en Zoho: {formatDateTime(pkg.sourceRemoteModifiedAt)}</span>
        <span>Sincronizado: {formatDateTime(pkg.normalizedAt)}</span>
        <span className="pkg-mono">ID Zoho {pkg.zohoPackageId}</span>
      </footer>
    </div>
  );
}
