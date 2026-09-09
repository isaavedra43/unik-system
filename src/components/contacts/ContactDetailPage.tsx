'use client';

import Link from 'next/link';
import { ArrowLeft, Bell, BellRing, Package, FileText, ShoppingCart, CreditCard, Receipt, Box } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';
import type { ContactDetail } from '@/modules/contacts/contacts-contract';
import {
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  getContactStatusConfig,
} from '@/modules/contacts/contacts-helpers';
import type {
  RelatedPackageSummary,
  RelatedInvoiceSummary,
  RelatedPaymentSummary,
  RelatedPurchaseOrderSummary,
  RelatedBillSummary,
  RelatedVendorCreditSummary,
  RelatedProductSummary,
  RelatedSalesOrderSummary,
} from '@/modules/cross-module/relationships-service';

interface ContactDetailPageProps {
  contact: ContactDetail;
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
  // Customer relationships
  relatedPackages?: RelatedPackageSummary[];
  relatedInvoices?: RelatedInvoiceSummary[];
  relatedSalesOrders?: RelatedSalesOrderSummary[];
  relatedPayments?: RelatedPaymentSummary[];
  // Vendor relationships
  relatedPurchaseOrders?: RelatedPurchaseOrderSummary[];
  relatedBills?: RelatedBillSummary[];
  relatedVendorCredits?: RelatedVendorCreditSummary[];
  relatedProducts?: RelatedProductSummary[];
}

export function ContactDetailPage({
  contact,
  entityLabel,
  entityLabelPlural,
  basePath,
  isWatched: initialWatched,
  canWatch,
  watchAction,
  unwatchAction,
  relatedPackages,
  relatedInvoices,
  relatedSalesOrders,
  relatedPayments,
  relatedPurchaseOrders,
  relatedBills,
  relatedVendorCredits,
  relatedProducts,
}: ContactDetailPageProps) {
  const [watched, setWatched] = useState(initialWatched);
  const isVendor = contact.contactType === 'vendor';

  const handleWatch = async () => {
    if (!canWatch) return;
    const formData = new FormData();
    formData.set('entityId', contact.id);
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

  return (
    <div className="app-content">
      <div
        className="page-header"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1rem',
        }}
      >
        <div>
          <Link
            href={basePath}
            style={{
              fontSize: '0.875rem',
              color: 'var(--unik-text-muted)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.25rem',
              marginBottom: '0.5rem',
            }}
          >
            <ArrowLeft size={14} /> {entityLabelPlural}
          </Link>
          <h1 className="page-title">{contact.contactName ?? entityLabel}</h1>
          <p className="page-description">{contact.companyName ?? '—'}</p>
        </div>
        {canWatch ? (
          <button className="btn btn-secondary btn-sm" onClick={handleWatch} aria-pressed={watched}>
            {watched ? <BellRing size={14} /> : <Bell size={14} />}
            {watched ? 'Siguiendo' : 'Seguir'}
          </button>
        ) : null}
      </div>

      {/* Top summary */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '0.75rem',
          marginBottom: '1rem',
        }}
      >
        <SummaryCard
          label="Estado"
          value={getContactStatusConfig(contact.status).label}
        />
        <SummaryCard
          label={isVendor ? 'Saldo por pagar' : 'Saldo por cobrar'}
          value={formatCurrency(isVendor ? contact.outstandingPayable : contact.outstandingReceivable, contact.currencyCode)}
        />
        <SummaryCard
          label={isVendor ? 'Créditos por pagar' : 'Créditos por cobrar'}
          value={formatCurrency(isVendor ? contact.unusedCreditsPayable : contact.unusedCreditsReceivable, contact.currencyCode)}
        />
        <SummaryCard label="Moneda" value={contact.currencyCode} />
      </div>

      {/* Two-column info */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '1rem',
          alignItems: 'start',
        }}
      >
        <div className="card">
          <h2 className="card-title">General</h2>
          <div className="so-detail-grid">
            <Field label="Nombre" value={contact.contactName} />
            <Field label="Empresa" value={contact.companyName} />
            <Field label="Tipo" value={contact.contactType} />
            {contact.customerSubType ? <Field label="Subtipo" value={contact.customerSubType} /> : null}
            <Field label="Términos de pago" value={contact.paymentTermsLabel} />
            <Field label="Moneda" value={contact.currencyCode} />
            <Field label="Idioma" value={contact.languageCode} />
            {contact.ownerName ? <Field label="Propietario" value={contact.ownerName} /> : null}
            {contact.source ? <Field label="Origen" value={contact.source} /> : null}
            {contact.portalStatus ? <Field label="Estado portal" value={contact.portalStatus} /> : null}
          </div>
        </div>

        <div className="card">
          <h2 className="card-title">Contacto</h2>
          <div className="so-detail-grid">
            <Field label="Correo" value={contact.primaryEmail} />
            <Field label="Teléfono" value={contact.primaryPhone} />
            {contact.mobile ? <Field label="Móvil" value={contact.mobile} /> : null}
            <Field label="Sitio web" value={contact.website} />
            {contact.firstName || contact.lastName ? (
              <Field label="Contacto" value={[contact.firstName, contact.lastName].filter(Boolean).join(' ') || null} />
            ) : null}
            {contact.designation ? <Field label="Cargo" value={contact.designation} /> : null}
            {contact.department ? <Field label="Departamento" value={contact.department} /> : null}
          </div>
        </div>

        {/* Fiscal (Mexico) */}
        {(contact.taxRegNo || contact.taxTreatment || contact.taxRegime || contact.legalName) ? (
          <div className="card">
            <h2 className="card-title">Fiscal</h2>
            <div className="so-detail-grid">
              <Field label="RFC" value={contact.taxRegNo} />
              <Field label="Tratamiento fiscal" value={contact.taxTreatment} />
              <Field label="Régimen fiscal" value={contact.taxRegime} />
              <Field label="Razón social" value={contact.legalName} />
              <Field
                label="TDS registrado"
                value={contact.isTdsRegistered === true ? 'Sí' : contact.isTdsRegistered === false ? 'No' : null}
              />
            </div>
          </div>
        ) : null}

        {/* Billing address */}
        {(contact.billingAddress || contact.billingCity || contact.billingState || contact.billingCountry) ? (
          <div className="card">
            <h2 className="card-title">Dirección de facturación</h2>
            <div className="so-detail-grid">
              <Field label="Calle" value={contact.billingAddress} />
              <Field label="Ciudad" value={contact.billingCity} />
              <Field label="Estado" value={contact.billingState} />
              <Field label="C.P." value={contact.billingZip} />
              <Field label="País" value={contact.billingCountry} />
              <Field label="Fax" value={contact.billingFax} />
            </div>
          </div>
        ) : null}

        {/* Shipping address */}
        {(contact.shippingAddress || contact.shippingCity || contact.shippingState || contact.shippingCountry) ? (
          <div className="card">
            <h2 className="card-title">Dirección de envío</h2>
            <div className="so-detail-grid">
              <Field label="Calle" value={contact.shippingAddress} />
              <Field label="Ciudad" value={contact.shippingCity} />
              <Field label="Estado" value={contact.shippingState} />
              <Field label="C.P." value={contact.shippingZip} />
              <Field label="País" value={contact.shippingCountry} />
              <Field label="Fax" value={contact.shippingFax} />
            </div>
          </div>
        ) : null}

        <div className="card">
          <h2 className="card-title">Saldos</h2>
          <div className="so-detail-grid">
            <Field
              label="Por cobrar"
              value={formatCurrency(contact.outstandingReceivable, contact.currencyCode)}
            />
            <Field
              label="Por pagar"
              value={formatCurrency(contact.outstandingPayable, contact.currencyCode)}
            />
            <Field
              label="Créditos por cobrar"
              value={formatCurrency(contact.unusedCreditsReceivable, contact.currencyCode)}
            />
            <Field
              label="Créditos por pagar"
              value={formatCurrency(contact.unusedCreditsPayable, contact.currencyCode)}
            />
            {contact.creditLimitExceededAmount ? (
              <Field
                label="Límite excedido"
                value={formatCurrency(contact.creditLimitExceededAmount, contact.currencyCode)}
              />
            ) : null}
          </div>
        </div>

        {contact.notes ? (
          <div className="card">
            <h2 className="card-title">Notas</h2>
            <p style={{ fontSize: '0.875rem', color: 'var(--unik-text-secondary)', whiteSpace: 'pre-wrap' }}>
              {contact.notes}
            </p>
          </div>
        ) : null}
      </div>

      {/* Sync info */}
      <div className="card">
        <h2 className="card-title">Sincronización</h2>
        <div className="so-detail-grid">
          <Field label="Última modificación remota" value={formatDateOnly(contact.sourceRemoteModifiedAt)} />
          <Field label="Normalizado" value={formatDateTime(contact.normalizedAt)} />
          <Field label="Zoho ID" value={contact.zohoContactId} />
        </div>
      </div>

      {/* Cross-module relationships */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '1rem',
          alignItems: 'start',
          marginTop: '1rem',
        }}
      >
        {/* Customer relationships */}
        {!isVendor && relatedSalesOrders && relatedSalesOrders.length > 0 ? (
          <RelatedCard
            title="Órdenes de venta"
            icon={<ShoppingCart size={16} />}
            items={relatedSalesOrders.map((so) => ({
              id: so.id,
              href: `/app/sales/orders/${so.id}`,
              primary: so.salesOrderNumber ?? '—',
              secondary: `${so.status ?? '—'} · ${formatCurrency(so.total, null)}`,
              date: so.date,
            }))}
          />
        ) : null}

        {!isVendor && relatedInvoices && relatedInvoices.length > 0 ? (
          <RelatedCard
            title="Facturas"
            icon={<FileText size={16} />}
            items={relatedInvoices.map((inv) => ({
              id: inv.id,
              href: `/app/invoices/${inv.id}`,
              primary: inv.invoiceNumber ?? '—',
              secondary: `${inv.status ?? '—'} · ${formatCurrency(inv.total, inv.currencyCode)}`,
              date: inv.date,
            }))}
          />
        ) : null}

        {!isVendor && relatedPackages && relatedPackages.length > 0 ? (
          <RelatedCard
            title="Paquetes"
            icon={<Package size={16} />}
            items={relatedPackages.map((pkg) => ({
              id: pkg.id,
              href: `/app/packages/${pkg.id}`,
              primary: pkg.packageNumber ?? '—',
              secondary: `${pkg.status ?? '—'} · ${pkg.carrier ?? ''}`,
              date: pkg.date,
            }))}
          />
        ) : null}

        {!isVendor && relatedPayments && relatedPayments.length > 0 ? (
          <RelatedCard
            title="Pagos recibidos"
            icon={<CreditCard size={16} />}
            items={relatedPayments.map((p) => ({
              id: p.id,
              href: `/app/payments/${p.id}`,
              primary: p.paymentNumber ?? '—',
              secondary: `${p.paymentMode ?? '—'} · ${formatCurrency(p.amount, p.currencyCode)}`,
              date: p.date,
            }))}
          />
        ) : null}

        {/* Vendor relationships */}
        {isVendor && relatedPurchaseOrders && relatedPurchaseOrders.length > 0 ? (
          <RelatedCard
            title="Órdenes de compra"
            icon={<ShoppingCart size={16} />}
            items={relatedPurchaseOrders.map((po) => ({
              id: po.id,
              href: `/app/purchase-orders/${po.id}`,
              primary: po.purchaseOrderNumber ?? '—',
              secondary: `${po.status ?? '—'} · ${formatCurrency(po.total, po.currencyCode)}`,
              date: po.date,
            }))}
          />
        ) : null}

        {isVendor && relatedBills && relatedBills.length > 0 ? (
          <RelatedCard
            title="Bills (Facturas del proveedor)"
            icon={<Receipt size={16} />}
            items={relatedBills.map((b) => ({
              id: b.id,
              href: `/app/bills/${b.id}`,
              primary: b.billNumber ?? '—',
              secondary: `${b.status ?? '—'} · ${formatCurrency(b.total, b.currencyCode)}`,
              date: b.date,
            }))}
          />
        ) : null}

        {isVendor && relatedVendorCredits && relatedVendorCredits.length > 0 ? (
          <RelatedCard
            title="Créditos del proveedor"
            icon={<CreditCard size={16} />}
            items={relatedVendorCredits.map((vc) => ({
              id: vc.id,
              href: `/app/vendor-credits/${vc.id}`,
              primary: vc.vendorCreditNumber ?? '—',
              secondary: `${vc.status ?? '—'} · ${formatCurrency(vc.total, vc.currencyCode)}`,
              date: vc.date,
            }))}
          />
        ) : null}

        {isVendor && relatedProducts && relatedProducts.length > 0 ? (
          <RelatedCard
            title="Productos del proveedor"
            icon={<Box size={16} />}
            items={relatedProducts.map((p) => ({
              id: p.id,
              href: `/app/products/${p.id}`,
              primary: p.name ?? '—',
              secondary: `${p.sku ?? '—'} · ${p.status ?? ''}`,
              date: null,
            }))}
          />
        ) : null}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  highlighted,
}: {
  label: string;
  value: string | null;
  highlighted?: boolean;
}) {
  return (
    <div className="so-detail-field">
      <span className="so-detail-field-label">{label}</span>
      <span className="so-detail-field-value" style={highlighted ? { fontWeight: 700 } : undefined}>
        {value ?? '—'}
      </span>
    </div>
  );
}

function SummaryCard({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  return (
    <div
      style={{
        padding: '0.75rem 1rem',
        background: 'var(--unik-surface)',
        borderRadius: 'var(--unik-radius-sm)',
        border: '1px solid var(--unik-border-subtle)',
      }}
    >
      <div
        style={{
          fontSize: '0.75rem',
          color: 'var(--unik-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.02em',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: '1rem', fontWeight: 600 }}>{value ?? '—'}</div>
    </div>
  );
}

interface RelatedCardItem {
  id: string;
  href: string;
  primary: string;
  secondary: string;
  date: string | null;
}

function RelatedCard({
  title,
  icon,
  items,
}: {
  title: string;
  icon: React.ReactNode;
  items: RelatedCardItem[];
}) {
  return (
    <div className="card">
      <h2 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {icon} {title} ({items.length})
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {items.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.5rem 0.75rem',
              borderRadius: 'var(--unik-radius-sm)',
              border: '1px solid var(--unik-border-subtle)',
              background: 'var(--unik-surface)',
              textDecoration: 'none',
              color: 'inherit',
              fontSize: '0.875rem',
            }}
          >
            <span style={{ fontWeight: 600 }}>{item.primary}</span>
            <span style={{ color: 'var(--unik-text-muted)', fontSize: '0.75rem' }}>
              {item.secondary}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
