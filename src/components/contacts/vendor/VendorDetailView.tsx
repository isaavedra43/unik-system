'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, Bell, BellRing, CreditCard, Link2Off, Receipt, RefreshCw, ShoppingCart } from 'lucide-react';
import { toast } from 'sonner';
import type { ContactDetail } from '@/modules/contacts/contacts-contract';
import { formatCurrency, formatDateOnly, formatDateTime, getContactStatusConfig } from '@/modules/contacts/contacts-helpers';
import { balanceGap } from '@/modules/contacts/vendor-profile-helpers';
import type { VendorProfile, VendorTransactionType } from '@/modules/contacts/vendor-profile-service';
import { DocumentTable } from './vendor-ui';
import { VendorTransactionsTable } from './VendorTransactionsTable';
import { VendorStatement } from './VendorStatement';

type WatchAction = (
  prevState: { error: string | null; success: boolean; isWatched: boolean },
  formData: FormData
) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;

type TabId = 'summary' | 'statement' | VendorTransactionType;

interface VendorDetailViewProps {
  contact: ContactDetail;
  profile: VendorProfile;
  isWatched: boolean;
  canWatch: boolean;
  watchAction: WatchAction;
  unwatchAction: WatchAction;
}

function initials(name: string | null): string {
  return (name ?? 'P')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="vd-info-row">
      <dt>{label}</dt>
      <dd>{value === null || value === undefined || value === '' ? <span className="vd-muted">—</span> : value}</dd>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  tone?: 'warning' | 'danger' | 'success';
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="vd-kpi-label">{label}</span>
      <span className={`vd-kpi-value${tone ? ` vd-kpi-${tone}` : ''}`}>{value}</span>
      {sub ? <span className="vd-kpi-sub">{sub}</span> : null}
    </>
  );
  return onClick ? (
    <button type="button" className="vd-kpi vd-kpi-button" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="vd-kpi">{content}</div>
  );
}

export function VendorDetailView({ contact, profile, isWatched, canWatch, watchAction, unwatchAction }: VendorDetailViewProps) {
  const [tab, setTab] = useState<TabId>('summary');
  const [watched, setWatched] = useState(isWatched);
  const currency = contact.currencyCode;
  const status = getContactStatusConfig(contact.status);
  const name = contact.contactName ?? 'Proveedor';

  const po = profile.purchaseOrders;
  const bills = profile.bills;
  const vc = profile.vendorCredits;
  const payableGap = bills ? balanceGap(contact.outstandingPayable, bills.unpaidBalance) : null;
  const creditsGap = vc ? balanceGap(contact.unusedCreditsPayable, vc.openBalance) : null;
  const unlinkedTotal = profile.unlinked.purchaseOrders + profile.unlinked.bills + profile.unlinked.vendorCredits;

  const handleWatch = async () => {
    if (!canWatch) return;
    const formData = new FormData();
    formData.set('entityId', contact.id);
    const result = watched
      ? await unwatchAction({ error: null, success: false, isWatched: true }, formData)
      : await watchAction({ error: null, success: false, isWatched: false }, formData);
    if (result.success) {
      setWatched(!watched);
      toast.success(watched ? 'Dejaste de seguir el proveedor' : 'Proveedor seguido');
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  const tabs: Array<{ id: TabId; label: string; count?: number }> = [
    { id: 'summary', label: 'Resumen' },
    ...(bills && vc ? [{ id: 'statement' as const, label: 'Estado de cuenta' }] : []),
    ...(po ? [{ id: 'purchase_orders' as const, label: 'Órdenes de compra', count: po.count }] : []),
    ...(bills ? [{ id: 'bills' as const, label: 'Facturas', count: bills.count }] : []),
    ...(vc ? [{ id: 'vendor_credits' as const, label: 'Créditos', count: vc.count }] : []),
  ];

  const hasAddress = Boolean(contact.billingAddress || contact.billingCity || contact.shippingAddress || contact.shippingCity);
  const addressLine = (parts: Array<string | null>) => parts.filter(Boolean).join(', ') || null;

  return (
    <div className="app-content vd">
      <Link href="/app/contacts/vendors" className="vd-back">
        <ArrowLeft size={14} aria-hidden="true" /> Proveedores
      </Link>

      <header className="vd-header">
        <div className="vd-identity">
          <span className="vd-avatar" aria-hidden="true">
            {initials(name)}
          </span>
          <div>
            <h1 className="vd-title">{name}</h1>
            <p className="vd-subtitle">
              <span className={`vd-pill vd-pill-${status.tone}`}>{status.label}</span>
              {contact.companyName && contact.companyName !== contact.contactName ? <span>{contact.companyName}</span> : null}
              {contact.taxRegNo ? <span>RFC {contact.taxRegNo}</span> : null}
              {contact.paymentTermsLabel ? <span>{contact.paymentTermsLabel}</span> : null}
            </p>
          </div>
        </div>
        {canWatch ? (
          <button className="btn btn-secondary btn-sm" onClick={handleWatch} aria-pressed={watched}>
            {watched ? <BellRing size={14} /> : <Bell size={14} />}
            {watched ? 'Siguiendo' : 'Seguir'}
          </button>
        ) : null}
      </header>

      <section className="vd-kpis" aria-label="Indicadores del proveedor">
        <Kpi
          label="Saldo por pagar"
          value={formatCurrency(contact.outstandingPayable, currency)}
          tone={Number(contact.outstandingPayable ?? 0) > 0 ? 'warning' : undefined}
          sub={
            payableGap !== null ? (
              <span className="vd-kpi-alert">
                <AlertTriangle size={11} aria-hidden="true" /> Facturas pendientes: {formatCurrency(bills?.unpaidBalance, currency)}
              </span>
            ) : bills ? (
              `${bills.unpaidCount} factura${bills.unpaidCount === 1 ? '' : 's'} pendiente${bills.unpaidCount === 1 ? '' : 's'}`
            ) : undefined
          }
          onClick={bills ? () => setTab('bills') : undefined}
        />
        <Kpi
          label="Créditos sin usar"
          value={formatCurrency(contact.unusedCreditsPayable, currency)}
          tone={Number(contact.unusedCreditsPayable ?? 0) > 0 ? 'success' : undefined}
          sub={
            creditsGap !== null ? (
              <span className="vd-kpi-alert">
                <AlertTriangle size={11} aria-hidden="true" /> Créditos abiertos: {formatCurrency(vc?.openBalance, currency)}
              </span>
            ) : vc ? (
              `${vc.openCount} crédito${vc.openCount === 1 ? '' : 's'} con saldo`
            ) : undefined
          }
          onClick={vc ? () => setTab('vendor_credits') : undefined}
        />
        {po ? (
          <Kpi
            label="Órdenes de compra"
            value={po.count.toLocaleString('es-MX')}
            sub={`${po.openCount} en curso · última ${po.lastDate ? formatDateOnly(po.lastDate) : '—'}`}
            onClick={() => setTab('purchase_orders')}
          />
        ) : null}
        {po ? <Kpi label="Comprado (total)" value={formatCurrency(po.totalAmount, currency)} sub="Sin borradores ni canceladas" /> : null}
        {bills ? (
          <Kpi
            label="Facturas vencidas"
            value={bills.overdueCount.toLocaleString('es-MX')}
            tone={bills.overdueCount > 0 ? 'danger' : undefined}
            sub={bills.overdueCount > 0 ? formatCurrency(bills.overdueBalance, currency) : 'Al corriente'}
            onClick={() => setTab('bills')}
          />
        ) : null}
      </section>

      {payableGap !== null || creditsGap !== null ? (
        <div className="vd-alert vd-alert-warning" role="status">
          <RefreshCw size={15} aria-hidden="true" />
          <div>
            <strong>Los saldos de Zoho no cuadran con los documentos sincronizados.</strong> Zoho no marca al proveedor como
            modificado cuando se pagan facturas o se aplican créditos; la sincronización ahora compara el contenido y refresca
            los saldos en la siguiente pasada completa. Última actualización de este proveedor: {formatDateTime(contact.normalizedAt)}.
          </div>
        </div>
      ) : null}

      {unlinkedTotal > 0 ? (
        <div className="vd-alert vd-alert-info" role="status">
          <Link2Off size={15} aria-hidden="true" />
          <div>
            Hay {unlinkedTotal} documento{unlinkedTotal === 1 ? '' : 's'} con el nombre “{name}” que en Zoho están asignados a
            otro proveedor o a ninguno, por eso no se cuentan aquí
            {profile.unlinked.purchaseOrders ? ` · ${profile.unlinked.purchaseOrders} órdenes` : ''}
            {profile.unlinked.bills ? ` · ${profile.unlinked.bills} facturas` : ''}
            {profile.unlinked.vendorCredits ? ` · ${profile.unlinked.vendorCredits} créditos` : ''}.
          </div>
        </div>
      ) : null}

      <div className="tabs vd-tabs" role="tablist" aria-label="Secciones del proveedor">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="tab" onClick={() => setTab(t.id)}>
            {t.label}
            {t.count !== undefined ? <span className="vd-tab-count">{t.count.toLocaleString('es-MX')}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'summary' ? (
        <div className="vd-layout">
          <div className="vd-main">
            {po ? (
              <section className="vd-card">
                <div className="vd-card-head">
                  <div>
                    <h2 className="vd-card-title">
                      <ShoppingCart size={16} aria-hidden="true" /> Últimas órdenes de compra
                    </h2>
                    <p className="vd-card-sub">
                      {profile.recentPurchaseOrders.length} más recientes de {po.count.toLocaleString('es-MX')}
                    </p>
                  </div>
                  {po.count > profile.recentPurchaseOrders.length ? (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTab('purchase_orders')}>
                      Ver las {po.count.toLocaleString('es-MX')}
                    </button>
                  ) : null}
                </div>
                <DocumentTable type="purchase_orders" rows={profile.recentPurchaseOrders} emptyText="Este proveedor no tiene órdenes de compra." compact />
              </section>
            ) : null}

            {vc ? (
              <section className="vd-card">
                <div className="vd-card-head">
                  <div>
                    <h2 className="vd-card-title">
                      <CreditCard size={16} aria-hidden="true" /> Últimos créditos del proveedor
                    </h2>
                    <p className="vd-card-sub">
                      {profile.recentVendorCredits.length} más recientes de {vc.count.toLocaleString('es-MX')} · {formatCurrency(vc.openBalance, currency)} disponible
                    </p>
                  </div>
                  {vc.count > profile.recentVendorCredits.length ? (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTab('vendor_credits')}>
                      Ver los {vc.count.toLocaleString('es-MX')}
                    </button>
                  ) : null}
                </div>
                <DocumentTable type="vendor_credits" rows={profile.recentVendorCredits} emptyText="Este proveedor no tiene créditos." compact />
              </section>
            ) : null}

            {bills && profile.unpaidBills.length > 0 ? (
              <section className="vd-card">
                <div className="vd-card-head">
                  <div>
                    <h2 className="vd-card-title">
                      <Receipt size={16} aria-hidden="true" /> Facturas por pagar
                    </h2>
                    <p className="vd-card-sub">
                      {bills.unpaidCount} con saldo · {formatCurrency(bills.unpaidBalance, currency)} · primero las que vencen antes
                    </p>
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTab('bills')}>
                    Ver todas
                  </button>
                </div>
                <DocumentTable type="bills" rows={profile.unpaidBills} emptyText="Sin facturas pendientes." compact />
              </section>
            ) : null}
          </div>

          <aside className="vd-side" aria-label="Información del proveedor">
            <section className="vd-card">
              <h2 className="vd-card-title">Información</h2>
              <dl className="vd-info">
                <InfoRow label="Nombre" value={contact.contactName} />
                <InfoRow label="Empresa" value={contact.companyName} />
                <InfoRow label="Términos de pago" value={contact.paymentTermsLabel} />
                <InfoRow label="Moneda" value={contact.currencyCode} />
                {profile.products > 0 ? <InfoRow label="Productos que surte" value={profile.products.toLocaleString('es-MX')} /> : null}
                {contact.ownerName ? <InfoRow label="Responsable" value={contact.ownerName} /> : null}
              </dl>
            </section>

            <section className="vd-card">
              <h2 className="vd-card-title">Contacto</h2>
              <dl className="vd-info">
                <InfoRow label="Persona" value={[contact.firstName, contact.lastName].filter(Boolean).join(' ') || null} />
                <InfoRow label="Correo" value={contact.primaryEmail ? <a href={`mailto:${contact.primaryEmail}`}>{contact.primaryEmail}</a> : null} />
                <InfoRow label="Teléfono" value={contact.primaryPhone ? <a href={`tel:${contact.primaryPhone}`}>{contact.primaryPhone}</a> : null} />
                {contact.mobile ? <InfoRow label="Móvil" value={<a href={`tel:${contact.mobile}`}>{contact.mobile}</a>} /> : null}
                {contact.website ? <InfoRow label="Sitio web" value={contact.website} /> : null}
              </dl>
            </section>

            <section className="vd-card">
              <h2 className="vd-card-title">Fiscal</h2>
              <dl className="vd-info">
                <InfoRow label="RFC" value={contact.taxRegNo} />
                <InfoRow label="Razón social" value={contact.legalName} />
                <InfoRow label="Régimen" value={contact.taxRegime} />
                <InfoRow label="Tratamiento del IVA" value={contact.taxTreatment === 'home_country_mexico' ? 'Dentro de México' : contact.taxTreatment} />
              </dl>
            </section>

            {hasAddress ? (
              <section className="vd-card">
                <h2 className="vd-card-title">Direcciones</h2>
                <dl className="vd-info">
                  <InfoRow label="Facturación" value={addressLine([contact.billingAddress, contact.billingCity, contact.billingState, contact.billingZip])} />
                  <InfoRow label="Envío" value={addressLine([contact.shippingAddress, contact.shippingCity, contact.shippingState, contact.shippingZip])} />
                </dl>
              </section>
            ) : null}

            {contact.notes ? (
              <section className="vd-card">
                <h2 className="vd-card-title">Notas</h2>
                <p className="vd-notes">{contact.notes}</p>
              </section>
            ) : null}

            <section className="vd-card">
              <h2 className="vd-card-title">Sincronización con Zoho</h2>
              <dl className="vd-info">
                <InfoRow label="Actualizado en UNIK" value={formatDateTime(contact.normalizedAt)} />
                <InfoRow label="Última edición en Zoho" value={formatDateOnly(contact.sourceRemoteModifiedAt)} />
                <InfoRow label="ID de Zoho" value={<code className="vd-code">{contact.zohoContactId}</code>} />
              </dl>
            </section>
          </aside>
        </div>
      ) : tab === 'statement' ? (
        <VendorStatement contactId={contact.id} vendorName={name} vendorRfc={contact.taxRegNo} currencyCode={currency} />
      ) : (
        <VendorTransactionsTable
          key={tab}
          contactId={contact.id}
          vendorName={name}
          type={tab}
          total={(tab === 'purchase_orders' ? po?.count : tab === 'bills' ? bills?.count : vc?.count) ?? 0}
          statuses={(tab === 'purchase_orders' ? po?.statuses : tab === 'bills' ? bills?.statuses : vc?.statuses) ?? []}
        />
      )}
    </div>
  );
}
