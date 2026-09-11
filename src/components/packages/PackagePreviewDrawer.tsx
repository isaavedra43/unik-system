'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, BellRing, ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';
import type { PackageDetail } from '@/modules/packages/packages-contract';
import {
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  formatNumber,
  getPackageStatusConfig,
} from '@/modules/packages/packages-helpers';

interface PreviewDrawerProps {
  packageId: string;
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

export function PackagePreviewDrawer({
  packageId,
  basePath,
  entityLabel,
  onClose,
  canWatch,
  isWatched,
  onWatchChange,
  watchAction,
  unwatchAction,
}: PreviewDrawerProps) {
  const router = useRouter();
  const [pkg, setPkg] = useState<PackageDetail | null>(null);
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
        const res = await fetch(`${basePath}/${packageId}/api`);
        if (!res.ok) throw new Error('No se pudo cargar el paquete');
        const json = (await res.json()) as PackageDetail & { is_watched?: boolean };
        if (!cancelled) {
          setPkg(json);
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
  }, [packageId, basePath]);

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
    formData.set('entityId', packageId);
    const result = watched
      ? await unwatchAction({ error: null, success: false, isWatched: true }, formData)
      : await watchAction({ error: null, success: false, isWatched: false }, formData);
    if (result.success) {
      setWatched(!watched);
      onWatchChange(!watched);
      toast.success(watched ? `Dejaste de seguir el ${entityLabel.toLowerCase()}` : `${entityLabel} seguido`);
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  const statusConfig = pkg ? getPackageStatusConfig(pkg.status) : null;

  const hasShippingAddress = pkg && Boolean(
    pkg.shippingAddress || pkg.shippingCity || pkg.shippingState || pkg.shippingZip || pkg.shippingCountry
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
              {pkg?.packageNumber ?? 'Cargando...'}
            </h2>
            {pkg?.customerName ? (
              <p style={{ color: 'var(--unik-text-muted)', fontSize: '0.875rem', margin: '4px 0 0' }}>
                {pkg.customerName}
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
            <button className="btn btn-secondary btn-sm" onClick={() => router.push(`${basePath}/${packageId}`)}>
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
          ) : pkg ? (
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
                    Estado
                  </div>
                  <div style={{ fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span className={`so-status-dot so-status-dot-${statusConfig?.tone ?? 'muted'}`} />
                    {statusConfig?.label ?? '—'}
                  </div>
                </div>
                {pkg.trackingNumber ? (
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                      Guía
                    </div>
                    <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>
                      {pkg.trackingNumber}
                    </div>
                  </div>
                ) : null}
              </div>

              {/* General */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">General</h3>
                <div className="so-detail-grid">
                  <Field label="Fecha" value={formatDateOnly(pkg.date)} />
                  <Field label="Fecha de envío" value={formatDateOnly(pkg.shipmentDate)} />
                  <Field label="Cliente" value={pkg.customerName} />
                  <Field label="Paquetería" value={pkg.carrier} />
                  <Field label="Tipo de envío" value={pkg.shipmentType} />
                  <Field label="Método de entrega" value={pkg.deliveryMethod} />
                  <Field label="Canal de venta" value={pkg.salesChannel} />
                  <Field label="Orden de venta" value={pkg.salesorderNumber} />
                  <Field label="Cantidad total" value={pkg.quantity ? formatNumber(pkg.quantity) : null} />
                  <Field label="Costo de envío" value={formatCurrency(pkg.shippingCharge)} />
                </div>
              </div>

              {/* Shipping address */}
              {hasShippingAddress ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Dirección de envío</h3>
                  <div className="so-detail-grid">
                    <Field label="Atención" value={pkg.shippingAttention} />
                    <Field label="Dirección" value={pkg.shippingAddress} />
                    <Field label="Ciudad" value={pkg.shippingCity} />
                    <Field label="Estado" value={pkg.shippingState} />
                    <Field label="Código postal" value={pkg.shippingZip} />
                    <Field label="País" value={pkg.shippingCountry} />
                    <Field label="Teléfono" value={pkg.shippingPhone} />
                  </div>
                </div>
              ) : null}

              {/* Items */}
              {pkg.items.length > 0 ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Contenido ({pkg.items.length})</h3>
                  <div className="table-wrap">
                    <table className="table so-table-compact">
                      <thead>
                        <tr>
                          <th>SKU</th>
                          <th>Producto</th>
                          <th style={{ textAlign: 'right' }}>Cantidad</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pkg.items.map((item) => (
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
                            <td style={{ textAlign: 'right' }}>
                              {formatNumber(item.quantity)} {item.unit ?? ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {/* Related sales order */}
              {pkg.relatedSalesOrder ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Orden de venta</h3>
                  <div className="so-detail-grid">
                    <Field label="Folio" value={pkg.relatedSalesOrder.salesOrderNumber} />
                    <Field label="Estado" value={pkg.relatedSalesOrder.status} />
                    <Field label="Fecha" value={formatDateOnly(pkg.relatedSalesOrder.date)} />
                    <Field label="Total" value={formatCurrency(pkg.relatedSalesOrder.total)} />
                  </div>
                  <Link
                    href={`/app/sales/orders/${pkg.relatedSalesOrder.id}`}
                    style={{
                      fontSize: '0.875rem',
                      color: 'var(--unik-accent)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                      marginTop: '0.5rem',
                    }}
                  >
                    <ExternalLink size={12} /> Ver orden de venta
                  </Link>
                </div>
              ) : null}

              {/* Related contact */}
              {pkg.relatedContact ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Cliente</h3>
                  <div className="so-detail-grid">
                    <Field label="Nombre" value={pkg.relatedContact.contactName} />
                    <Field label="Empresa" value={pkg.relatedContact.companyName} />
                    <Field label="Tipo" value={pkg.relatedContact.contactType} />
                  </div>
                  {pkg.relatedContact.id ? (
                    <Link
                      href={`/app/contacts/customers/${pkg.relatedContact.id}`}
                      style={{
                        fontSize: '0.875rem',
                        color: 'var(--unik-accent)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        marginTop: '0.5rem',
                      }}
                    >
                      <ExternalLink size={12} /> Ver cliente
                    </Link>
                  ) : null}
                </div>
              ) : null}

              {/* Sync */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Sincronización</h3>
                <div className="so-detail-grid">
                  <Field label="Últ. modificación remota" value={formatDateTime(pkg.sourceRemoteModifiedAt)} />
                  <Field label="Normalizado" value={formatDateTime(pkg.normalizedAt)} />
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
