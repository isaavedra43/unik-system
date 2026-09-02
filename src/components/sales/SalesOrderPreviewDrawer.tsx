'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellRing, ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';
import { watchOrderAction, unwatchOrderAction } from '@/app/app/sales/orders/actions';
import type { SalesOrderDetail } from '@/modules/sales/sales-orders-contract';
import {
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  formatQuantity,
  getSalesOrderStatusConfig,
} from '@/modules/sales/sales-orders-helpers';

interface PreviewDrawerProps {
  orderId: string;
  onClose: () => void;
  canWatch: boolean;
  isWatched: boolean;
  onWatchChange: (watched: boolean) => void;
}

export function SalesOrderPreviewDrawer({
  orderId,
  onClose,
  canWatch,
  isWatched,
  onWatchChange,
}: PreviewDrawerProps) {
  const router = useRouter();
  const [order, setOrder] = useState<SalesOrderDetail | null>(null);
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
        const res = await fetch(`/app/sales/orders/${orderId}/api`);
        if (!res.ok) throw new Error('No pudimos cargar la orden.');
        const json = (await res.json()) as SalesOrderDetail & { is_watched?: boolean };
        if (!cancelled) {
          setOrder(json);
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
  }, [orderId]);

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
    formData.set('entityId', orderId);
    const result = watched
      ? await unwatchOrderAction({ error: null, success: false, isWatched: true }, formData)
      : await watchOrderAction({ error: null, success: false, isWatched: false }, formData);
    if (result.success) {
      setWatched(!watched);
      onWatchChange(!watched);
      toast.success(watched ? 'Dejaste de seguir la orden' : 'Orden seguida');
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  return (
    <>
      <div className="overlay" onClick={onClose} aria-hidden="true" />
      <aside
        className="so-detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Detalle de orden"
      >
        <div className="so-detail-header">
          <div>
            <h2 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>
              {order?.salesOrderNumber ?? 'Cargando...'}
            </h2>
            {order?.customerName ? (
              <p
                style={{
                  color: 'var(--unik-text-muted)',
                  fontSize: '0.875rem',
                  margin: '4px 0 0',
                }}
              >
                {order.customerName}
              </p>
            ) : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {canWatch ? (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleWatch}
                aria-pressed={watched}
              >
                {watched ? <BellRing size={14} /> : <Bell size={14} />}
                {watched ? 'Siguiendo' : 'Seguir'}
              </button>
            ) : null}
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => router.push(`/app/sales/orders/${orderId}`)}
            >
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
          ) : order ? (
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
                  <div
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--unik-text-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.02em',
                    }}
                  >
                    Total
                  </div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>
                    {formatCurrency(order.total, order.currencyCode)}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--unik-text-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.02em',
                    }}
                  >
                    Saldo
                  </div>
                  <div style={{ fontSize: '1rem', fontWeight: 600 }}>
                    {formatCurrency(order.balance, order.currencyCode)}
                  </div>
                </div>
              </div>

              {/* Status strip */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Estados</h3>
                <div className="so-status-strip">
                  <StatusTile
                    label="Orden"
                    value={getSalesOrderStatusConfig(order.status, 'order').label}
                    tone={getSalesOrderStatusConfig(order.status, 'order').tone}
                  />
                  <StatusTile
                    label="Pago"
                    value={getSalesOrderStatusConfig(order.paidStatus, 'payment').label}
                    tone={getSalesOrderStatusConfig(order.paidStatus, 'payment').tone}
                  />
                  <StatusTile
                    label="Facturación"
                    value={getSalesOrderStatusConfig(order.invoicedStatus, 'invoice').label}
                    tone={getSalesOrderStatusConfig(order.invoicedStatus, 'invoice').tone}
                  />
                  <StatusTile
                    label="Envío"
                    value={getSalesOrderStatusConfig(order.shippedStatus, 'shipping').label}
                    tone={getSalesOrderStatusConfig(order.shippedStatus, 'shipping').tone}
                  />
                </div>
              </div>

              {/* General */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">General</h3>
                <div className="so-detail-grid">
                  <Field label="Fecha" value={formatDateOnly(order.orderDate)} />
                  <Field label="Referencia" value={order.referenceNumber} />
                  <Field label="Vendedor" value={order.salespersonName} />
                  <Field label="Forma de pago" value={order.paymentMethod} />
                  <Field label="Método de entrega" value={order.deliveryMethod} />
                  <Field label="Ubicación" value={order.locationName} />
                  <Field label="Sucursal" value={order.branchName} />
                  <Field label="Moneda" value={order.currencyCode} />
                </div>
              </div>

              {/* Customer */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Cliente</h3>
                <div className="so-detail-grid">
                  <Field label="Nombre" value={order.customerName} />
                  <Field label="Correo" value={order.customerEmail} />
                  <Field label="Teléfono" value={order.customerPhone} />
                </div>
              </div>

              {/* Shipping */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Envío</h3>
                <div className="so-detail-grid">
                  <Field label="Atención" value={order.shippingAttention} />
                  <Field
                    label="Dirección"
                    value={
                      [order.shippingAddressLine1, order.shippingAddressLine2]
                        .filter(Boolean)
                        .join(', ') || null
                    }
                  />
                  <Field label="Ciudad" value={order.shippingCity} />
                  <Field label="Estado" value={order.shippingState} />
                  <Field label="Código postal" value={order.shippingPostalCode} />
                  <Field label="País" value={order.shippingCountry} />
                  <Field label="Teléfono" value={order.shippingPhone} />
                </div>
              </div>

              {/* Totals */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Totales</h3>
                <div className="so-detail-grid">
                  <Field
                    label="Subtotal"
                    value={formatCurrency(order.subtotal, order.currencyCode)}
                  />
                  <Field
                    label="Descuento"
                    value={formatCurrency(order.discountTotal, order.currencyCode)}
                  />
                  <Field
                    label="Impuestos"
                    value={formatCurrency(order.taxTotal, order.currencyCode)}
                  />
                  <Field
                    label="Envío"
                    value={formatCurrency(order.shippingCharge, order.currencyCode)}
                  />
                  <Field
                    label="Ajuste"
                    value={formatCurrency(order.adjustment, order.currencyCode)}
                  />
                  <Field
                    label="Total"
                    value={formatCurrency(order.total, order.currencyCode)}
                    highlighted
                  />
                  <Field
                    label="Saldo"
                    value={formatCurrency(order.balance, order.currencyCode)}
                    highlighted
                  />
                </div>
              </div>

              {/* Items */}
              {order.items.length > 0 ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Artículos ({order.items.length})</h3>
                  <div className="table-wrap">
                    <table className="table so-table-compact">
                      <thead>
                        <tr>
                          <th>SKU</th>
                          <th>Producto</th>
                          <th style={{ textAlign: 'right' }}>Cantidad</th>
                          <th style={{ textAlign: 'right' }}>Precio</th>
                          <th style={{ textAlign: 'right' }}>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {order.items.map((item) => (
                          <tr key={item.id}>
                            <td>{item.sku ?? '—'}</td>
                            <td>
                              <div>{item.name ?? '—'}</div>
                              {item.description ? (
                                <div
                                  style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)' }}
                                >
                                  {item.description}
                                </div>
                              ) : null}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {formatQuantity(item.quantity, item.unit)}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {formatCurrency(item.rate, order.currencyCode)}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {formatCurrency(item.lineTotal, order.currencyCode)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {/* Notes */}
              {order.notes ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Notas</h3>
                  <p
                    style={{
                      fontSize: '0.875rem',
                      color: 'var(--unik-text-secondary)',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {order.notes}
                  </p>
                </div>
              ) : null}

              {/* Activity */}
              {order.change_events && order.change_events.length > 0 ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Actividad reciente</h3>
                  {order.change_events.map((event) => {
                    const changes = event.changes as {
                      fields?: Record<string, { before: unknown; after: unknown }>;
                    };
                    const fieldNames = changes.fields ? Object.keys(changes.fields) : [];
                    return (
                      <div key={event.id} className="so-activity-item">
                        <span className="so-activity-time">{formatDateTime(event.createdAt)}</span>
                        <div className="so-activity-content">
                          <div>Cambios detectados</div>
                          {fieldNames.slice(0, 3).map((f) => {
                            const change = changes.fields![f];
                            return (
                              <div key={f} className="so-activity-change">
                                {f}: {String(change.before ?? '—')} → {String(change.after ?? '—')}
                              </div>
                            );
                          })}
                          {fieldNames.length > 3 ? (
                            <div className="so-activity-change">+{fieldNames.length - 3} más</div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
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
