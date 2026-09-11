'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellRing, ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';
import type { PurchaseOrderDetail } from '@/modules/purchase-orders/purchase-orders-contract';
import {
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  getPurchaseOrderStatusConfig,
} from '@/modules/purchase-orders/purchase-orders-helpers';
import type { WatchAction } from '@/modules/shared/entity-workspace-types';

interface PurchaseOrderPreviewDrawerProps {
  entityId: string;
  basePath: string;
  entityLabel: string;
  onClose: () => void;
  canWatch: boolean;
  isWatched: boolean;
  onWatchChange: (watched: boolean) => void;
  watchAction: WatchAction;
  unwatchAction: WatchAction;
}

export function PurchaseOrderPreviewDrawer({
  entityId,
  basePath,
  entityLabel,
  onClose,
  canWatch,
  isWatched,
  onWatchChange,
  watchAction,
  unwatchAction,
}: PurchaseOrderPreviewDrawerProps) {
  const router = useRouter();
  const [purchaseOrder, setPurchaseOrder] = useState<PurchaseOrderDetail | null>(null);
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
        const res = await fetch(`${basePath}/${entityId}/api`);
        if (!res.ok) throw new Error('No se pudo cargar la orden de compra');
        const json = (await res.json()) as PurchaseOrderDetail & { is_watched?: boolean };
        if (!cancelled) {
          setPurchaseOrder(json);
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
  }, [entityId, basePath]);

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
    formData.set('entityId', entityId);
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

  const statusConfig = purchaseOrder ? getPurchaseOrderStatusConfig(purchaseOrder.status) : null;

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
              {purchaseOrder?.purchaseOrderNumber ?? 'Cargando...'}
            </h2>
            {purchaseOrder?.vendorName ? (
              <p style={{ color: 'var(--unik-text-muted)', fontSize: '0.875rem', margin: '4px 0 0' }}>
                {purchaseOrder.vendorName}
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
            <button className="btn btn-secondary btn-sm" onClick={() => router.push(`${basePath}/${entityId}`)}>
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
          ) : purchaseOrder ? (
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
                    {formatCurrency(purchaseOrder.total, purchaseOrder.currencyCode)}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                    Saldo
                  </div>
                  <div style={{ fontSize: '1rem', fontWeight: 600 }}>
                    {formatCurrency(purchaseOrder.balance, purchaseOrder.currencyCode)}
                  </div>
                </div>
              </div>

              {/* Status strip */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Estado</h3>
                <div className="so-status-strip">
                  <StatusTile
                    label="Orden"
                    value={statusConfig?.label ?? '—'}
                    tone={statusConfig?.tone ?? 'muted'}
                  />
                </div>
              </div>

              {/* General */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">General</h3>
                <div className="so-detail-grid">
                  <Field label="Fecha" value={formatDateOnly(purchaseOrder.date)} />
                  <Field label="Vencimiento" value={formatDateOnly(purchaseOrder.dueDate)} />
                  <Field label="Fecha de entrega" value={formatDateOnly(purchaseOrder.deliveryDate)} />
                  <Field label="Proveedor" value={purchaseOrder.vendorName} />
                  <Field label="Vendedor" value={purchaseOrder.salespersonName} />
                  <Field label="Referencia" value={purchaseOrder.referenceNumber} />
                  <Field label="Moneda" value={purchaseOrder.currencyCode} />
                </div>
              </div>

              {/* Totales */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Totales</h3>
                <div className="so-detail-grid">
                  <Field label="Subtotal" value={formatCurrency(purchaseOrder.subTotal, purchaseOrder.currencyCode)} />
                  <Field label="Descuento" value={formatCurrency(purchaseOrder.discountTotal, purchaseOrder.currencyCode)} />
                  <Field label="Impuestos" value={formatCurrency(purchaseOrder.taxTotal, purchaseOrder.currencyCode)} />
                  <Field label="Envío" value={formatCurrency(purchaseOrder.shippingCharge, purchaseOrder.currencyCode)} />
                  <Field label="Total" value={formatCurrency(purchaseOrder.total, purchaseOrder.currencyCode)} highlighted />
                  <Field label="Saldo" value={formatCurrency(purchaseOrder.balance, purchaseOrder.currencyCode)} highlighted />
                </div>
              </div>

              {/* Items */}
              {purchaseOrder.items.length > 0 ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Artículos ({purchaseOrder.items.length})</h3>
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
                        {purchaseOrder.items.map((item) => (
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
                              {formatCurrency(item.rate, purchaseOrder.currencyCode)}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {formatCurrency(item.lineTotal, purchaseOrder.currencyCode)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {/* Notas */}
              {purchaseOrder.notes ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Notas</h3>
                  <p style={{ fontSize: '0.875rem', color: 'var(--unik-text-secondary)', whiteSpace: 'pre-wrap' }}>
                    {purchaseOrder.notes}
                  </p>
                </div>
              ) : null}

              {/* Sync */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Sincronización</h3>
                <div className="so-detail-grid">
                  <Field label="Últ. modificación remota" value={formatDateTime(purchaseOrder.sourceRemoteModifiedAt)} />
                  <Field label="Normalizado" value={formatDateTime(purchaseOrder.normalizedAt)} />
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
