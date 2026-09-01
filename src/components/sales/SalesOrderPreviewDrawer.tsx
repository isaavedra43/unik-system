'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellRing, ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';
import { watchOrderAction, unwatchOrderAction } from '@/app/app/sales/orders/actions';

interface PreviewDrawerProps {
  orderId: string;
  onClose: () => void;
  canWatch: boolean;
  isWatched: boolean;
  onWatchChange: (watched: boolean) => void;
}

interface OrderDetail {
  id: string;
  sales_order_number: string | null;
  reference_number: string | null;
  order_date: string | null;
  status: string | null;
  sub_status: string | null;
  paid_status: string | null;
  invoiced_status: string | null;
  shipped_status: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  salesperson_name: string | null;
  payment_method: string | null;
  delivery_method: string | null;
  location_name: string | null;
  branch_name: string | null;
  currency_code: string | null;
  subtotal: string | null;
  discount_total: string | null;
  tax_total: string | null;
  shipping_charge: string | null;
  adjustment: string | null;
  total: string | null;
  balance: string | null;
  notes: string | null;
  shipping_attention: string | null;
  shipping_address_line_1: string | null;
  shipping_address_line_2: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
  shipping_postal_code: string | null;
  shipping_country: string | null;
  shipping_phone: string | null;
  items: {
    id: string;
    sku: string | null;
    name: string | null;
    description: string | null;
    quantity: string | null;
    unit: string | null;
    rate: string | null;
    discount_amount: string | null;
    tax_name: string | null;
    tax_percentage: string | null;
    tax_amount: string | null;
    line_total: string | null;
  }[];
  change_events?: {
    id: string;
    changes: unknown;
    source_remote_modified_at: string | null;
    created_at: string;
  }[];
}

function formatCurrency(value: string | null, currency?: string | null): string {
  if (value === null || value === undefined) return '—';
  const num = Number(value);
  if (Number.isNaN(num)) return value;
  const formatted = num.toLocaleString('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${formatted} ${currency}` : `$${formatted}`;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('es-MX', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return value;
  }
}

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return value;
  }
}

export function SalesOrderPreviewDrawer({
  orderId,
  onClose,
  canWatch,
  isWatched,
  onWatchChange,
}: PreviewDrawerProps) {
  const router = useRouter();
  const [order, setOrder] = useState<OrderDetail | null>(null);
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
        const json = await res.json();
        if (!cancelled) setOrder(json);
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
    if (watched) {
      const result = await unwatchOrderAction(
        { error: null, success: false, isWatched: true },
        formData
      );
      if (result.success) {
        setWatched(false);
        onWatchChange(false);
        toast.success('Dejaste de seguir la orden');
      } else {
        toast.error(result.error ?? 'Error');
      }
    } else {
      const result = await watchOrderAction(
        { error: null, success: false, isWatched: false },
        formData
      );
      if (result.success) {
        setWatched(true);
        onWatchChange(true);
        toast.success('Orden seguida');
      } else {
        toast.error(result.error ?? 'Error');
      }
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
              {order?.sales_order_number ?? 'Cargando...'}
            </h2>
            {order?.customer_name ? (
              <p
                style={{ color: 'var(--unik-text-muted)', fontSize: '0.875rem', margin: '4px 0 0' }}
              >
                {order.customer_name}
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
              {/* Status panel */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Estados</h3>
                <div className="so-status-panel">
                  <div className="so-status-card">
                    <div className="so-status-card-label">Estado orden</div>
                    <div className="so-status-card-value">{order.status ?? '—'}</div>
                  </div>
                  <div className="so-status-card">
                    <div className="so-status-card-label">Estado pago</div>
                    <div className="so-status-card-value">{order.paid_status ?? '—'}</div>
                  </div>
                  <div className="so-status-card">
                    <div className="so-status-card-label">Facturada</div>
                    <div className="so-status-card-value">{order.invoiced_status ?? '—'}</div>
                  </div>
                  <div className="so-status-card">
                    <div className="so-status-card-label">Estado envío</div>
                    <div className="so-status-card-value">{order.shipped_status ?? '—'}</div>
                  </div>
                </div>
              </div>

              {/* General */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">General</h3>
                <div className="so-detail-grid">
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Fecha</span>
                    <span className="so-detail-field-value">{formatDate(order.order_date)}</span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Referencia</span>
                    <span className="so-detail-field-value">{order.reference_number ?? '—'}</span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Vendedor</span>
                    <span className="so-detail-field-value">{order.salesperson_name ?? '—'}</span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Forma de pago</span>
                    <span className="so-detail-field-value">{order.payment_method ?? '—'}</span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Método de entrega</span>
                    <span className="so-detail-field-value">{order.delivery_method ?? '—'}</span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Ubicación</span>
                    <span className="so-detail-field-value">{order.location_name ?? '—'}</span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Sucursal</span>
                    <span className="so-detail-field-value">{order.branch_name ?? '—'}</span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Moneda</span>
                    <span className="so-detail-field-value">{order.currency_code ?? '—'}</span>
                  </div>
                </div>
              </div>

              {/* Customer */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Cliente</h3>
                <div className="so-detail-grid">
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Nombre</span>
                    <span className="so-detail-field-value">{order.customer_name ?? '—'}</span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Correo</span>
                    <span className="so-detail-field-value">{order.customer_email ?? '—'}</span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Teléfono</span>
                    <span className="so-detail-field-value">{order.customer_phone ?? '—'}</span>
                  </div>
                </div>
              </div>

              {/* Shipping */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Envío</h3>
                <div className="so-detail-grid">
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Atención</span>
                    <span className="so-detail-field-value">{order.shipping_attention ?? '—'}</span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Dirección</span>
                    <span className="so-detail-field-value">
                      {[order.shipping_address_line_1, order.shipping_address_line_2]
                        .filter(Boolean)
                        .join(', ') || '—'}
                    </span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Ciudad</span>
                    <span className="so-detail-field-value">{order.shipping_city ?? '—'}</span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Estado</span>
                    <span className="so-detail-field-value">{order.shipping_state ?? '—'}</span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Código postal</span>
                    <span className="so-detail-field-value">
                      {order.shipping_postal_code ?? '—'}
                    </span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">País</span>
                    <span className="so-detail-field-value">{order.shipping_country ?? '—'}</span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Teléfono</span>
                    <span className="so-detail-field-value">{order.shipping_phone ?? '—'}</span>
                  </div>
                </div>
              </div>

              {/* Totals */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Totales</h3>
                <div className="so-detail-grid">
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Subtotal</span>
                    <span className="so-detail-field-value">
                      {formatCurrency(order.subtotal, order.currency_code)}
                    </span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Descuento</span>
                    <span className="so-detail-field-value">
                      {formatCurrency(order.discount_total, order.currency_code)}
                    </span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Impuestos</span>
                    <span className="so-detail-field-value">
                      {formatCurrency(order.tax_total, order.currency_code)}
                    </span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Envío</span>
                    <span className="so-detail-field-value">
                      {formatCurrency(order.shipping_charge, order.currency_code)}
                    </span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Ajuste</span>
                    <span className="so-detail-field-value">
                      {formatCurrency(order.adjustment, order.currency_code)}
                    </span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Total</span>
                    <span className="so-detail-field-value" style={{ fontWeight: 700 }}>
                      {formatCurrency(order.total, order.currency_code)}
                    </span>
                  </div>
                  <div className="so-detail-field">
                    <span className="so-detail-field-label">Saldo</span>
                    <span className="so-detail-field-value" style={{ fontWeight: 700 }}>
                      {formatCurrency(order.balance, order.currency_code)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Items */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Artículos ({order.items.length})</h3>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th>Nombre</th>
                        <th style={{ textAlign: 'right' }}>Cantidad</th>
                        <th style={{ textAlign: 'right' }}>Precio</th>
                        <th style={{ textAlign: 'right' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {order.items.map((item) => (
                        <tr key={item.id}>
                          <td>{item.sku ?? '—'}</td>
                          <td>{item.name ?? '—'}</td>
                          <td style={{ textAlign: 'right' }}>{item.quantity ?? '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            {formatCurrency(item.rate, order.currency_code)}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {formatCurrency(item.line_total, order.currency_code)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

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
                        <span className="so-activity-time">{formatDateTime(event.created_at)}</span>
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
