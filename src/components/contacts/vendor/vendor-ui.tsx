'use client';

import React from 'react';
import Link from 'next/link';
import { formatCurrency, formatDateOnly } from '@/modules/contacts/contacts-helpers';
import { getPurchaseOrderStatusConfig } from '@/modules/purchase-orders/purchase-orders-helpers';
import { getBillStatusConfig } from '@/modules/bills/bills-helpers';
import { getVendorCreditStatusConfig } from '@/modules/vendor-credits/vendor-credits-helpers';
import type { VendorTransactionRow, VendorTransactionType } from '@/modules/contacts/vendor-profile-service';

export function statusConfigFor(type: VendorTransactionType, status: string | null) {
  if (type === 'purchase_orders') return getPurchaseOrderStatusConfig(status);
  if (type === 'bills') return getBillStatusConfig(status);
  return getVendorCreditStatusConfig(status);
}

export function StatusPill({ type, status }: { type: VendorTransactionType; status: string | null }) {
  const cfg = statusConfigFor(type, status);
  return <span className={`vd-pill vd-pill-${cfg.tone}`}>{cfg.label}</span>;
}

export const TYPE_LABELS: Record<VendorTransactionType, { plural: string; singular: string; balance: string }> = {
  purchase_orders: { plural: 'Órdenes de compra', singular: 'Orden de compra', balance: 'Por facturar' },
  bills: { plural: 'Facturas del proveedor', singular: 'Factura', balance: 'Saldo' },
  vendor_credits: { plural: 'Créditos del proveedor', singular: 'Crédito', balance: 'Disponible' },
};

/** Document table used by the summary and the full history tabs. */
export function DocumentTable({
  type,
  rows,
  emptyText,
  compact = false,
}: {
  type: VendorTransactionType;
  rows: VendorTransactionRow[];
  emptyText: string;
  compact?: boolean;
}) {
  if (rows.length === 0) return <p className="vd-empty">{emptyText}</p>;
  const showDue = type !== 'vendor_credits';
  return (
    <div className="vd-table-wrap">
      <table className={`vd-table${compact ? ' vd-table-compact' : ''}`}>
        <thead>
          <tr>
            <th scope="col">Folio</th>
            <th scope="col">Fecha</th>
            {showDue && !compact ? <th scope="col">{type === 'bills' ? 'Vence' : 'Entrega'}</th> : null}
            {type === 'bills' && !compact ? <th scope="col">Orden de compra</th> : null}
            <th scope="col">Estado</th>
            <th scope="col" className="vd-num">Total</th>
            <th scope="col" className="vd-num">{TYPE_LABELS[type].balance}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const hasBalance = Number(r.balance ?? 0) > 0;
            return (
              <tr key={r.id}>
                <td>
                  <Link href={r.href} className="vd-doc-link">
                    {r.number ?? '—'}
                  </Link>
                  {r.reference && !compact ? <span className="vd-muted-inline"> · {r.reference}</span> : null}
                </td>
                <td className="vd-nowrap">{r.date ? formatDateOnly(r.date) : '—'}</td>
                {showDue && !compact ? <td className="vd-nowrap">{r.dueDate ? formatDateOnly(r.dueDate) : '—'}</td> : null}
                {type === 'bills' && !compact ? (
                  <td>
                    {r.purchaseOrder ? (
                      <Link href={`/app/purchase-orders/${r.purchaseOrder.id}`} className="vd-doc-link vd-doc-link-soft">
                        {r.purchaseOrder.number ?? 'Ver orden'}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                ) : null}
                <td>
                  <StatusPill type={type} status={r.status} />
                </td>
                <td className="vd-num">{formatCurrency(r.total, r.currencyCode)}</td>
                <td className={`vd-num${hasBalance ? ' vd-num-strong' : ' vd-num-muted'}`}>{formatCurrency(r.balance, r.currencyCode)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
