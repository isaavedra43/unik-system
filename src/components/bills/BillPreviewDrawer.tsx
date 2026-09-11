'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, BellRing, ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';
import type { BillDetail } from '@/modules/bills/bills-contract';
import {
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  getBillStatusConfig,
} from '@/modules/bills/bills-helpers';

interface BillPreviewDrawerProps {
  billId: string;
  basePath: string;
  entityLabel: string;
  onClose: () => void;
  canWatch: boolean;
  isWatched: boolean;
  onWatchChange: (watched: boolean) => void;
  watchAction: (
    prevState: { error: string | null; success: boolean; isWatched: boolean },
    formData: FormData
  ) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;
  unwatchAction: (
    prevState: { error: string | null; success: boolean; isWatched: boolean },
    formData: FormData
  ) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;
}

export function BillPreviewDrawer({
  billId,
  basePath,
  entityLabel,
  onClose,
  canWatch,
  isWatched,
  onWatchChange,
  watchAction,
  unwatchAction,
}: BillPreviewDrawerProps) {
  const router = useRouter();
  const [bill, setBill] = useState<BillDetail | null>(null);
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
        const res = await fetch(`${basePath}/${billId}/api`);
        if (!res.ok) throw new Error('No se pudo cargar la factura de compra');
        const json = (await res.json()) as BillDetail & { is_watched?: boolean };
        if (!cancelled) {
          setBill(json);
          if (typeof json.is_watched === 'boolean') setWatched(json.is_watched);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [billId, basePath]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleWatch = async () => {
    if (!canWatch) return;
    const formData = new FormData();
    formData.set('entityId', billId);
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

  const statusConfig = bill ? getBillStatusConfig(bill.status) : null;

  return (
    <>
      <div className="overlay" onClick={onClose} aria-hidden="true" />
      <aside
        className="so-detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Detalle de ${entityLabel.toLowerCase()}`}
      >
        <div className="so-detail-header">
          <div>
            <h2 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>
              {bill?.billNumber ?? 'Cargando...'}
            </h2>
            {bill?.vendorName ? (
              <p style={{ color: 'var(--unik-text-muted)', fontSize: '0.875rem', margin: '4px 0 0' }}>
                {bill.vendorName}
              </p>
            ) : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {canWatch ? (
              <button className="btn btn-secondary btn-sm" onClick={handleWatch} aria-pressed={watched}>
                {watched ? <BellRing size={14} /> : <Bell size={14} />}
                {watched ? 'Siguiendo' : 'Seguir'}
              </button>
            ) : null}
            <button className="btn btn-secondary btn-sm" onClick={() => router.push(`${basePath}/${billId}`)}>
              <ExternalLink size={14} /> Abrir
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="so-detail-body">
          {loading ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <span className="spinner" /> Cargando...
            </div>
          ) : error ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <p className="text-muted">{error}</p>
            </div>
          ) : bill ? (
            <>
              {/* Summary */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  padding: '0.75rem 1rem',
                  background: 'var(--unik-surface)',
                  borderRadius: 'var(--unik-radius-sm)',
                  border: '1px solid var(--unik-border-subtle)',
                  marginBottom: '1rem',
                }}
              >
                <div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                    Total
                  </div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>
                    {formatCurrency(bill.total, bill.currencyCode)}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                    Saldo
                  </div>
                  <div style={{ fontSize: '1rem', fontWeight: 600 }}>
                    {formatCurrency(bill.balance, bill.currencyCode)}
                  </div>
                </div>
              </div>

              {/* Status strip */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Estado</h3>
                <div className="so-status-strip">
                  <StatusTile
                    label="Factura"
                    value={statusConfig?.label ?? '—'}
                    tone={statusConfig?.tone ?? 'muted'}
                  />
                </div>
              </div>

              {/* General */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">General</h3>
                <div className="so-detail-grid">
                  <Field label="Fecha" value={formatDateOnly(bill.date)} />
                  <Field label="Vencimiento" value={formatDateOnly(bill.dueDate)} />
                  <Field label="Proveedor" value={bill.vendorName} />
                  <Field label="Moneda" value={bill.currencyCode} />
                  <Field label="Orden de compra" value={bill.zohoPurchaseOrderId} />
                </div>
              </div>

              {/* Totales */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Totales</h3>
                <div className="so-detail-grid">
                  <Field label="Subtotal" value={formatCurrency(bill.subTotal, bill.currencyCode)} />
                  <Field label="Impuestos" value={formatCurrency(bill.taxTotal, bill.currencyCode)} />
                  <Field label="Créditos aplicados" value={formatCurrency(bill.vendorCreditsApplied, bill.currencyCode)} />
                  <Field label="Total" value={formatCurrency(bill.total, bill.currencyCode)} highlighted />
                  <Field label="Saldo" value={formatCurrency(bill.balance, bill.currencyCode)} highlighted />
                </div>
              </div>

              {/* Related purchase order */}
              {bill.relatedPurchaseOrder ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Orden de compra</h3>
                  <div className="so-detail-grid">
                    <Field label="Folio" value={bill.relatedPurchaseOrder.purchaseOrderNumber} />
                    <Field label="Estado" value={bill.relatedPurchaseOrder.status} />
                    <Field label="Fecha" value={formatDateOnly(bill.relatedPurchaseOrder.date)} />
                    <Field label="Total" value={formatCurrency(bill.relatedPurchaseOrder.total, bill.currencyCode)} />
                  </div>
                  <Link
                    href={`/app/purchase-orders/${bill.relatedPurchaseOrder.id}`}
                    style={{
                      fontSize: '0.875rem',
                      color: 'var(--unik-accent)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                      marginTop: '0.5rem',
                    }}
                  >
                    <ExternalLink size={12} /> Ver orden de compra
                  </Link>
                </div>
              ) : null}

              {/* Related contact (vendor) */}
              {bill.relatedContact ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Proveedor</h3>
                  <div className="so-detail-grid">
                    <Field label="Nombre" value={bill.relatedContact.contactName} />
                    <Field label="Empresa" value={bill.relatedContact.companyName} />
                    <Field label="Tipo" value={bill.relatedContact.contactType} />
                  </div>
                  {bill.relatedContact.id ? (
                    <Link
                      href={`/app/contacts/vendors/${bill.relatedContact.id}`}
                      style={{
                        fontSize: '0.875rem',
                        color: 'var(--unik-accent)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        marginTop: '0.5rem',
                      }}
                    >
                      <ExternalLink size={12} /> Ver proveedor
                    </Link>
                  ) : null}
                </div>
              ) : null}

              {/* Related vendor credits */}
              {bill.relatedVendorCredits && bill.relatedVendorCredits.length > 0 ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Créditos de proveedor ({bill.relatedVendorCredits.length})</h3>
                  <div className="table-wrap">
                    <table className="table so-table-compact so-related-table">
                      <thead>
                        <tr>
                          <th>Crédito</th>
                          <th>Estado</th>
                          <th>Fecha</th>
                          <th style={{ textAlign: 'right' }}>Total</th>
                          <th style={{ textAlign: 'right' }}>Saldo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bill.relatedVendorCredits.map((vc) => (
                          <tr
                            key={vc.id}
                            onClick={() => router.push(`/app/vendor-credits/${vc.id}`)}
                            style={{ cursor: 'pointer' }}
                          >
                            <td>{vc.vendorCreditNumber ?? '—'}</td>
                            <td>{vc.status ?? '—'}</td>
                            <td>{formatDateOnly(vc.date)}</td>
                            <td style={{ textAlign: 'right' }}>{formatCurrency(vc.total, vc.currencyCode)}</td>
                            <td style={{ textAlign: 'right' }}>{formatCurrency(vc.balance, vc.currencyCode)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {/* Notas */}
              {bill.notes ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Notas</h3>
                  <p style={{ fontSize: '0.875rem', color: 'var(--unik-text-secondary)', whiteSpace: 'pre-wrap' }}>
                    {bill.notes}
                  </p>
                </div>
              ) : null}

              {/* Sync */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Sincronización</h3>
                <div className="so-detail-grid">
                  <Field label="Últ. modificación remota" value={formatDateTime(bill.sourceRemoteModifiedAt)} />
                  <Field label="Normalizado" value={formatDateTime(bill.normalizedAt)} />
                </div>
              </div>
            </>
          ) : null}
        </div>
      </aside>
    </>
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

function StatusTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'success' | 'info' | 'warning' | 'danger' | 'muted';
}) {
  return (
    <div className="so-status-tile" title={`${label}: ${value}`}>
      <span className={`so-status-dot so-status-dot-${tone}`} />
      <div>
        <div className="so-status-tile-label">{label}</div>
        <div className="so-status-tile-value">{value}</div>
      </div>
    </div>
  );
}
