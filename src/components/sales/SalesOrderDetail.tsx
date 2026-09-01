'use client';

import Link from 'next/link';
import { ArrowLeft, Bell, BellRing } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';
import { watchOrderAction, unwatchOrderAction } from '@/app/app/sales/orders/actions';

interface SalesOrderDetailProps {
  order: {
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
  };
  changeEvents: {
    id: string;
    changes: unknown;
    sourceRemoteModifiedAt: string | null;
    createdAt: string;
  }[];
  isWatched: boolean;
  canWatch: boolean;
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

export function SalesOrderDetail({
  order,
  changeEvents,
  isWatched: initialWatched,
  canWatch,
}: SalesOrderDetailProps) {
  const [watched, setWatched] = useState(initialWatched);

  const handleWatch = async () => {
    if (!canWatch) return;
    const formData = new FormData();
    formData.set('entityId', order.id);
    if (watched) {
      const result = await unwatchOrderAction(
        { error: null, success: false, isWatched: true },
        formData
      );
      if (result.success) {
        setWatched(false);
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
        toast.success('Orden seguida');
      } else {
        toast.error(result.error ?? 'Error');
      }
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
            href="/app/sales/orders"
            style={{
              fontSize: '0.875rem',
              color: 'var(--unik-text-muted)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.25rem',
              marginBottom: '0.5rem',
            }}
          >
            <ArrowLeft size={14} /> Órdenes de venta
          </Link>
          <h1 className="page-title">{order.sales_order_number ?? 'Orden de venta'}</h1>
          <p className="page-description">{order.customer_name ?? 'Cliente no especificado'}</p>
        </div>
        {canWatch ? (
          <button className="btn btn-secondary btn-sm" onClick={handleWatch} aria-pressed={watched}>
            {watched ? <BellRing size={14} /> : <Bell size={14} />}
            {watched ? 'Siguiendo' : 'Seguir'}
          </button>
        ) : null}
      </div>

      {/* Status panel */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Estados</h2>
        </div>
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
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">General</h2>
        </div>
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
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Cliente</h2>
        </div>
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
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Envío</h2>
        </div>
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
            <span className="so-detail-field-value">{order.shipping_postal_code ?? '—'}</span>
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
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Totales</h2>
        </div>
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
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Artículos ({order.items.length})</h2>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Nombre</th>
                <th>Descripción</th>
                <th style={{ textAlign: 'right' }}>Cantidad</th>
                <th style={{ textAlign: 'right' }}>Precio</th>
                <th style={{ textAlign: 'right' }}>Descuento</th>
                <th>Impuesto</th>
                <th style={{ textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.sku ?? '—'}</td>
                  <td>{item.name ?? '—'}</td>
                  <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.description ?? '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>{item.quantity ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {formatCurrency(item.rate, order.currency_code)}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {formatCurrency(item.discount_amount, order.currency_code)}
                  </td>
                  <td>{item.tax_name ?? '—'}</td>
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
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Notas</h2>
          </div>
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

      {/* Activity timeline */}
      {changeEvents.length > 0 ? (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Historial de cambios ({changeEvents.length})</h2>
          </div>
          {changeEvents.map((event) => {
            const changes = event.changes as {
              fields?: Record<string, { before: unknown; after: unknown }>;
              items?: Record<string, unknown>;
            };
            const fieldNames = changes.fields ? Object.keys(changes.fields) : [];
            return (
              <div key={event.id} className="so-activity-item">
                <span className="so-activity-time">{formatDateTime(event.createdAt)}</span>
                <div className="so-activity-content">
                  <div>Cambios detectados</div>
                  {fieldNames.map((f) => {
                    const change = changes.fields![f];
                    return (
                      <div key={f} className="so-activity-change">
                        <strong>{f}:</strong> {String(change.before ?? '—')} →{' '}
                        {String(change.after ?? '—')}
                      </div>
                    );
                  })}
                  {changes.items ? (
                    <div className="so-activity-change">
                      Cambios en artículos: {JSON.stringify(changes.items).slice(0, 100)}...
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
