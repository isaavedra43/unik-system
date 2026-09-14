'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { formatCurrency, formatDateOnly } from '@/modules/contacts/contacts-helpers';
import type { VendorProfile, VendorTransactionRow, VendorTransactionType } from '@/modules/contacts/vendor-profile-service';
import { StatusPill } from './vendor-ui';

function MiniList({ title, type, rows, total, href }: { title: string; type: VendorTransactionType; rows: VendorTransactionRow[]; total: number; href: string }) {
  return (
    <div className="so-detail-section">
      <div className="vd-mini-head">
        <h3 className="so-detail-section-title">
          {title} <span className="vd-muted">({total.toLocaleString('es-MX')})</span>
        </h3>
        {total > rows.length ? (
          <Link href={href} className="vd-doc-link vd-doc-link-soft">
            Ver todo
          </Link>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="vd-empty">Sin registros.</p>
      ) : (
        <ul className="vd-mini-list">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={r.href} className="vd-mini-item">
                <span className="vd-mini-main">
                  <strong>{r.number ?? '—'}</strong>
                  <span className="vd-muted">{r.date ? formatDateOnly(r.date) : '—'}</span>
                </span>
                <span className="vd-mini-side">
                  <StatusPill type={type} status={r.status} />
                  <span className="vd-num">{formatCurrency(r.total, r.currencyCode)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Vendor block of the list preview drawer: totals + latest purchase orders and credits. */
export function VendorPreviewSummary({ contactId, basePath, currencyCode }: { contactId: string; basePath: string; currencyCode: string | null }) {
  const [profile, setProfile] = useState<VendorProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setError(null);
    fetch(`${basePath}/${contactId}/profile?recent=5`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((json as { error?: string }).error ?? `Error ${res.status}`);
        return json as VendorProfile;
      })
      .then((json) => !cancelled && setProfile(json))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Error'));
    return () => {
      cancelled = true;
    };
  }, [contactId, basePath]);

  if (error) return <p className="vd-empty">{error}</p>;
  if (!profile) {
    return (
      <div className="vd-loading">
        <Loader2 size={16} className="vd-spin" aria-hidden="true" /> Cargando compras y créditos…
      </div>
    );
  }

  const detail = `${basePath}/${contactId}`;
  return (
    <>
      <div className="vd-mini-kpis">
        {profile.purchaseOrders ? (
          <div>
            <span className="vd-kpi-label">Órdenes de compra</span>
            <strong>{profile.purchaseOrders.count.toLocaleString('es-MX')}</strong>
            <span className="vd-muted">{profile.purchaseOrders.openCount} en curso</span>
          </div>
        ) : null}
        {profile.bills ? (
          <div>
            <span className="vd-kpi-label">Facturas pendientes</span>
            <strong>{formatCurrency(profile.bills.unpaidBalance, currencyCode)}</strong>
            <span className="vd-muted">{profile.bills.unpaidCount} con saldo</span>
          </div>
        ) : null}
        {profile.vendorCredits ? (
          <div>
            <span className="vd-kpi-label">Créditos abiertos</span>
            <strong>{formatCurrency(profile.vendorCredits.openBalance, currencyCode)}</strong>
            <span className="vd-muted">{profile.vendorCredits.openCount} con saldo</span>
          </div>
        ) : null}
      </div>
      {profile.purchaseOrders ? (
        <MiniList title="Últimas órdenes de compra" type="purchase_orders" rows={profile.recentPurchaseOrders} total={profile.purchaseOrders.count} href={detail} />
      ) : null}
      {profile.vendorCredits ? (
        <MiniList title="Últimos créditos" type="vendor_credits" rows={profile.recentVendorCredits} total={profile.vendorCredits.count} href={detail} />
      ) : null}
    </>
  );
}
