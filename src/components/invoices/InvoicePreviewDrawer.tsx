'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellRing, ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';
import type { InvoiceDetail } from '@/modules/invoices/invoices-contract';
import {
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  getInvoiceStatusConfig,
} from '@/modules/invoices/invoices-helpers';

interface InvoicePreviewDrawerProps {
  invoiceId: string;
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

export function InvoicePreviewDrawer({
  invoiceId,
  basePath,
  entityLabel,
  onClose,
  canWatch,
  isWatched,
  onWatchChange,
  watchAction,
  unwatchAction,
}: InvoicePreviewDrawerProps) {
  const router = useRouter();
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
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
        const res = await fetch(`${basePath}/${invoiceId}/api`);
        if (!res.ok) throw new Error('No se pudo cargar la factura');
        const json = (await res.json()) as InvoiceDetail & { is_watched?: boolean };
        if (!cancelled) {
          setInvoice(json);
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
  }, [invoiceId, basePath]);

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
    formData.set('entityId', invoiceId);
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

  const statusConfig = invoice ? getInvoiceStatusConfig(invoice.status) : null;

  const hasCfdi = invoice && Boolean(
    invoice.cfdiUuid ||
    invoice.cfdiVersion ||
    invoice.usoCfdi ||
    invoice.metodoPago ||
    invoice.formaPago ||
    invoice.regimenFiscal ||
    invoice.cfdiExportacion
  );

  const hasBillingAddress = invoice && Boolean(
    invoice.billingAddress || invoice.billingCity || invoice.billingState || invoice.billingZip || invoice.billingCountry
  );

  const hasShippingAddress = invoice && Boolean(
    invoice.shippingAddress || invoice.shippingCity || invoice.shippingState || invoice.shippingZip || invoice.shippingCountry
  );

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
              {invoice?.invoiceNumber ?? 'Cargando...'}
            </h2>
            {invoice?.customerName ? (
              <p style={{ color: 'var(--unik-text-muted)', fontSize: '0.875rem', margin: '4px 0 0' }}>
                {invoice.customerName}
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
            <button className="btn btn-secondary btn-sm" onClick={() => router.push(`${basePath}/${invoiceId}`)}>
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
          ) : invoice ? (
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
                    {formatCurrency(invoice.total, invoice.currencyCode)}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                    Saldo
                  </div>
                  <div style={{ fontSize: '1rem', fontWeight: 600 }}>
                    {formatCurrency(invoice.balance, invoice.currencyCode)}
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
                  <Field label="Fecha" value={formatDateOnly(invoice.date)} />
                  <Field label="Vencimiento" value={formatDateOnly(invoice.dueDate)} />
                  <Field label="Vendedor" value={invoice.salespersonName} />
                  <Field label="Referencia" value={invoice.referenceNumber} />
                  <Field label="Moneda" value={invoice.currencyCode} />
                  <Field label="Tipo de cambio" value={invoice.exchangeRate} />
                </div>
              </div>

              {/* Cliente */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Cliente</h3>
                <div className="so-detail-grid">
                  <Field label="Nombre" value={invoice.customerName} />
                </div>
              </div>

              {/* Billing address */}
              {hasBillingAddress ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Dirección de facturación</h3>
                  <div className="so-detail-grid">
                    <Field label="Dirección" value={invoice.billingAddress} />
                    <Field label="Ciudad" value={invoice.billingCity} />
                    <Field label="Estado" value={invoice.billingState} />
                    <Field label="Código postal" value={invoice.billingZip} />
                    <Field label="País" value={invoice.billingCountry} />
                  </div>
                </div>
              ) : null}

              {/* Shipping address */}
              {hasShippingAddress ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Dirección de envío</h3>
                  <div className="so-detail-grid">
                    <Field label="Dirección" value={invoice.shippingAddress} />
                    <Field label="Ciudad" value={invoice.shippingCity} />
                    <Field label="Estado" value={invoice.shippingState} />
                    <Field label="Código postal" value={invoice.shippingZip} />
                    <Field label="País" value={invoice.shippingCountry} />
                  </div>
                </div>
              ) : null}

              {/* Totals */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Totales</h3>
                <div className="so-detail-grid">
                  <Field label="Subtotal" value={formatCurrency(invoice.subTotal, invoice.currencyCode)} />
                  <Field label="Descuento" value={formatCurrency(invoice.discountTotal, invoice.currencyCode)} />
                  <Field label="Impuestos" value={formatCurrency(invoice.taxTotal, invoice.currencyCode)} />
                  <Field label="Envío" value={formatCurrency(invoice.shippingCharge, invoice.currencyCode)} />
                  <Field label="Total" value={formatCurrency(invoice.total, invoice.currencyCode)} highlighted />
                  <Field label="Saldo" value={formatCurrency(invoice.balance, invoice.currencyCode)} highlighted />
                </div>
              </div>

              {/* CFDI */}
              {hasCfdi ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Datos CFDI</h3>
                  <div className="so-detail-grid">
                    <Field label="UUID" value={invoice.cfdiUuid} />
                    <Field label="Versión" value={invoice.cfdiVersion} />
                    <Field label="Uso CFDI" value={invoice.usoCfdi} />
                    <Field label="Método de pago" value={invoice.metodoPago} />
                    <Field label="Forma de pago" value={invoice.formaPago} />
                    <Field label="Régimen fiscal" value={invoice.regimenFiscal} />
                    <Field label="Exportación" value={invoice.cfdiExportacion} />
                  </div>
                </div>
              ) : null}

              {/* Items */}
              {invoice.items.length > 0 ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Conceptos ({invoice.items.length})</h3>
                  <div className="table-wrap">
                    <table className="table so-table-compact">
                      <thead>
                        <tr>
                          <th>Producto</th>
                          <th style={{ textAlign: 'right' }}>Cantidad</th>
                          <th style={{ textAlign: 'right' }}>Precio</th>
                          <th style={{ textAlign: 'right' }}>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {invoice.items.map((item) => (
                          <tr key={item.id}>
                            <td>
                              <div>{item.name ?? '—'}</div>
                              {item.description ? (
                                <div style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)' }}>
                                  {item.description}
                                </div>
                              ) : null}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {item.quantity ?? '—'} {item.unit ?? ''}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {formatCurrency(item.rate, invoice.currencyCode)}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {formatCurrency(item.lineTotal, invoice.currencyCode)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {/* Notes */}
              {invoice.notes ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Notas</h3>
                  <p style={{ fontSize: '0.875rem', color: 'var(--unik-text-secondary)', whiteSpace: 'pre-wrap' }}>
                    {invoice.notes}
                  </p>
                </div>
              ) : null}

              {/* Terms */}
              {invoice.terms ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Términos</h3>
                  <p style={{ fontSize: '0.875rem', color: 'var(--unik-text-secondary)', whiteSpace: 'pre-wrap' }}>
                    {invoice.terms}
                  </p>
                </div>
              ) : null}

              {/* Sync */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Sincronización</h3>
                <div className="so-detail-grid">
                  <Field label="Últ. modificación remota" value={formatDateTime(invoice.sourceRemoteModifiedAt)} />
                  <Field label="Normalizado" value={formatDateTime(invoice.normalizedAt)} />
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
