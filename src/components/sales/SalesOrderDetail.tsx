'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Bell, BellRing, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';
import { watchOrderAction, unwatchOrderAction } from '@/app/app/sales/orders/actions';
import type { SalesOrderDetail } from '@/modules/sales/sales-orders-contract';
import {
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  formatQuantity,
  getSalesOrderStatusConfig,
  getTicketStatus,
  getTicketLifecycleSteps,
} from '@/modules/sales/sales-orders-helpers';

interface SalesOrderDetailProps {
  order: SalesOrderDetail;
  changeEvents: {
    id: string;
    changes: unknown;
    sourceRemoteModifiedAt: string | null;
    createdAt: string;
  }[];
  isWatched: boolean;
  canWatch: boolean;
}

export function SalesOrderDetail({
  order,
  changeEvents,
  isWatched: initialWatched,
  canWatch,
}: SalesOrderDetailProps) {
  const router = useRouter();
  const [watched, setWatched] = useState(initialWatched);

  const handleWatch = async () => {
    if (!canWatch) return;
    const formData = new FormData();
    formData.set('entityId', order.id);
    const result = watched
      ? await unwatchOrderAction({ error: null, success: false, isWatched: true }, formData)
      : await watchOrderAction({ error: null, success: false, isWatched: false }, formData);
    if (result.success) {
      setWatched(!watched);
      toast.success(watched ? 'Dejaste de seguir la orden' : 'Orden seguida');
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  const shippingAddress = [order.shippingAddressLine1, order.shippingAddressLine2]
    .filter(Boolean)
    .join(', ');

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
          <h1 className="page-title">{order.salesOrderNumber ?? 'Orden de venta'}</h1>
          <p className="page-description">{order.customerName ?? 'Cliente no especificado'}</p>
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
        <SummaryCard label="Total" value={formatCurrency(order.total, order.currencyCode)} large />
        <SummaryCard label="Saldo" value={formatCurrency(order.balance, order.currencyCode)} />
        <SummaryCard label="Fecha" value={formatDateOnly(order.orderDate)} />
        <SummaryCard label="Método de entrega" value={order.deliveryMethod} />
      </div>

      {/* Status strip */}
      <div className="card" style={{ padding: '0.75rem 1rem' }}>
        <div className="so-status-strip">
          <StatusTile
            label="Ticket"
            value={getTicketStatus(order).label}
            tone={getTicketStatus(order).tone}
          />
          <StatusTile
            label="Orden"
            value={getSalesOrderStatusConfig(order.status, 'order').label}
            tone={getSalesOrderStatusConfig(order.status, 'order').tone}
          />
          {order.subStatus ? (
            <StatusTile
              label="Sub-estado"
              value={getSalesOrderStatusConfig(order.subStatus, 'sub_status').label}
              tone={getSalesOrderStatusConfig(order.subStatus, 'sub_status').tone}
            />
          ) : null}
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

      {/* Lifecycle bar */}
      <div className="card" style={{ padding: '1rem' }}>
        <h2 className="card-title" style={{ marginBottom: '0.75rem' }}>Ciclo de vida del ticket</h2>
        <div className="ticket-lifecycle-bar">
          {getTicketLifecycleSteps(order).map((step, idx) => (
            <div key={step.label} className="ticket-lifecycle-step-wrapper">
              <div className={`ticket-lifecycle-step ticket-lifecycle-${step.status}`}>
                <span className="ticket-lifecycle-dot" />
                <span className="ticket-lifecycle-label">{step.label}</span>
              </div>
              {idx < 6 ? (
                <div className={`ticket-lifecycle-connector ticket-lifecycle-connector-${step.status}`} />
              ) : null}
            </div>
          ))}
        </div>
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
            <Field label="Fecha" value={formatDateOnly(order.orderDate)} />
            <Field label="Referencia" value={order.referenceNumber} />
            <Field label="Vendedor" value={order.salespersonName} />
            <Field label="Forma de pago" value={order.paymentMethod} />
            <Field label="Ubicación" value={order.locationName} />
            <Field label="Sucursal" value={order.branchName} />
            <Field label="Moneda" value={order.currencyCode} />
          </div>
        </div>

        <div className="card">
          <h2 className="card-title">Cliente</h2>
          <div className="so-detail-grid">
            <Field label="Nombre" value={order.customerName} />
            <Field label="Correo" value={order.customerEmail} />
            <Field label="Teléfono" value={order.customerPhone} />
          </div>
        </div>

        <div className="card">
          <h2 className="card-title">Envío</h2>
          <div className="so-detail-grid">
            <Field label="Atención" value={order.shippingAttention} />
            <Field label="Dirección" value={shippingAddress || null} />
            <Field label="Ciudad" value={order.shippingCity} />
            <Field label="Estado" value={order.shippingState} />
            <Field label="Código postal" value={order.shippingPostalCode} />
            <Field label="País" value={order.shippingCountry} />
            <Field label="Teléfono" value={order.shippingPhone} />
          </div>
        </div>

        <div className="card">
          <h2 className="card-title">Totales</h2>
          <div className="so-detail-grid">
            <Field label="Subtotal" value={formatCurrency(order.subtotal, order.currencyCode)} />
            <Field
              label="Descuento"
              value={formatCurrency(order.discountTotal, order.currencyCode)}
            />
            <Field label="Impuestos" value={formatCurrency(order.taxTotal, order.currencyCode)} />
            <Field label="Envío" value={formatCurrency(order.shippingCharge, order.currencyCode)} />
            <Field label="Ajuste" value={formatCurrency(order.adjustment, order.currencyCode)} />
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
      </div>

      {/* Items */}
      <div className="card">
        <h2 className="card-title">Artículos ({order.items.length})</h2>
        <div className="table-wrap">
          <table className="table">
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
                      <div style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)' }}>
                        {item.description}
                      </div>
                    ) : null}
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatQuantity(item.quantity, item.unit)}</td>
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

      {/* Related invoices */}
      {order.relatedInvoices && order.relatedInvoices.length > 0 ? (
        <div className="card">
          <h2 className="card-title">Facturas relacionadas ({order.relatedInvoices.length})</h2>
          <div className="table-wrap">
            <table className="table so-related-table">
              <thead>
                <tr>
                  <th>Factura</th>
                  <th>Estado</th>
                  <th>Fecha</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th style={{ textAlign: 'right' }}>Saldo</th>
                </tr>
              </thead>
              <tbody>
                {order.relatedInvoices.map((inv) => (
                  <tr key={inv.id} onClick={() => router.push(`/app/invoices/${inv.id}`)} style={{ cursor: 'pointer' }}>
                    <td>{inv.invoiceNumber ?? '—'}</td>
                    <td>{getSalesOrderStatusConfig(inv.status, 'invoice').label}</td>
                    <td>{formatDateOnly(inv.date)}</td>
                    <td style={{ textAlign: 'right' }}>{formatCurrency(inv.total, inv.currencyCode)}</td>
                    <td style={{ textAlign: 'right' }}>{formatCurrency(inv.balance, inv.currencyCode)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* Related packages */}
      {order.relatedPackages && order.relatedPackages.length > 0 ? (
        <div className="card">
          <h2 className="card-title">Paquetes relacionados ({order.relatedPackages.length})</h2>
          <div className="table-wrap">
            <table className="table so-related-table">
              <thead>
                <tr>
                  <th>Paquete</th>
                  <th>Estado</th>
                  <th>Fecha</th>
                  <th>Transportista</th>
                  <th>Guía</th>
                </tr>
              </thead>
              <tbody>
                {order.relatedPackages.map((pkg) => (
                  <tr key={pkg.id} onClick={() => router.push(`/app/packages/${pkg.id}`)} style={{ cursor: 'pointer' }}>
                    <td>{pkg.packageNumber ?? '—'}</td>
                    <td>{getSalesOrderStatusConfig(pkg.status, 'shipping').label}</td>
                    <td>{formatDateOnly(pkg.date)}</td>
                    <td>{pkg.carrier ?? '—'}</td>
                    <td>{pkg.trackingNumber ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* Related payments */}
      {order.relatedPayments && order.relatedPayments.length > 0 ? (
        <div className="card">
          <h2 className="card-title">Pagos relacionados ({order.relatedPayments.length})</h2>
          <div className="table-wrap">
            <table className="table so-related-table">
              <thead>
                <tr>
                  <th>Folio</th>
                  <th>Modo</th>
                  <th>Fecha</th>
                  <th style={{ textAlign: 'right' }}>Monto</th>
                </tr>
              </thead>
              <tbody>
                {order.relatedPayments.map((pay) => (
                  <tr key={pay.id} onClick={() => router.push(`/app/payments/${pay.id}`)} style={{ cursor: 'pointer' }}>
                    <td>{pay.paymentNumber ?? '—'}</td>
                    <td>{pay.paymentMode ?? '—'}</td>
                    <td>{formatDateOnly(pay.date)}</td>
                    <td style={{ textAlign: 'right' }}>{formatCurrency(pay.amount, pay.currencyCode)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* Related contact */}
      {order.relatedContact ? (
        <div className="card">
          <h2 className="card-title">Cliente</h2>
          <div className="so-detail-grid">
            <Field label="Nombre" value={order.relatedContact.contactName} />
            <Field label="Empresa" value={order.relatedContact.companyName} />
            <Field label="Tipo" value={order.relatedContact.contactType} />
          </div>
          {order.relatedContact.id ? (
            <Link
              href={`/app/contacts/customers/${order.relatedContact.id}`}
              style={{
                fontSize: '0.875rem',
                color: 'var(--unik-accent)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
                marginTop: '0.5rem',
              }}
            >
              <ExternalLink size={12} /> Ver cliente completo
            </Link>
          ) : null}
        </div>
      ) : null}

      {/* Notes */}
      {order.notes ? (
        <div className="card">
          <h2 className="card-title">Notas</h2>
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
      {changeEvents.length > 0 ? (
        <div className="card">
          <h2 className="card-title">Historial de cambios ({changeEvents.length})</h2>
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

function SummaryCard({
  label,
  value,
  large,
}: {
  label: string;
  value: string | null;
  large?: boolean;
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
      <div style={{ fontSize: large ? '1.25rem' : '1rem', fontWeight: large ? 700 : 600 }}>
        {value ?? '—'}
      </div>
    </div>
  );
}
