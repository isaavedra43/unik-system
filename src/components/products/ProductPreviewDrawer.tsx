'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellRing, ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';
import type { ProductDetail } from '@/modules/products/products-contract';
import {
  formatCurrency,
  formatNumber,
  formatDateTime,
  getProductStatusConfig,
} from '@/modules/products/products-helpers';

interface PreviewDrawerProps {
  productId: string;
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

export function ProductPreviewDrawer({
  productId,
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
  const [product, setProduct] = useState<ProductDetail | null>(null);
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
        const res = await fetch(`${basePath}/${productId}/api`);
        if (!res.ok) throw new Error('No se pudo cargar el producto');
        const json = (await res.json()) as ProductDetail & { is_watched?: boolean };
        if (!cancelled) {
          setProduct(json);
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
  }, [productId, basePath]);

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
    formData.set('entityId', productId);
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

  const statusConfig = product ? getProductStatusConfig(product.status) : null;

  const hasSat = product && Boolean(product.satProductCode || product.satUnitCode);
  const hasTax = product && Boolean(product.taxName || product.taxPercentage || product.isTaxable !== null);
  const hasVendor = product && Boolean(product.vendorName || product.manufacturer || product.brand);
  const hasAccounting = product && Boolean(
    product.purchaseAccountName || product.salesAccountName || product.inventoryAccountName || product.inventoryValuationMethod
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
              {product?.name ?? 'Cargando...'}
            </h2>
            {product?.sku ? (
              <p style={{ color: 'var(--unik-text-muted)', fontSize: '0.875rem', margin: '4px 0 0' }}>
                SKU: {product.sku}
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
            <button className="btn btn-secondary btn-sm" onClick={() => router.push(`${basePath}/${productId}`)}>
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
          ) : product ? (
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
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                    Stock disponible
                  </div>
                  <div style={{ fontSize: '1rem', fontWeight: 600 }}>
                    {formatNumber(product.availableStock)} {product.unit ?? ''}
                  </div>
                </div>
              </div>

              {/* General */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">General</h3>
                <div className="so-detail-grid">
                  <Field label="Nombre" value={product.name} />
                  <Field label="SKU" value={product.sku} />
                  <Field label="Tipo" value={product.productType} />
                  <Field label="Tipo de item" value={product.itemType} />
                  <Field label="Categoría" value={product.categoryName} />
                  <Field label="Marca" value={product.brand} />
                  <Field label="Fabricante" value={product.manufacturer} />
                  <Field label="Unidad" value={product.unit} />
                  <Field label="Moneda" value={product.currencyCode} />
                  <Field label="Origen" value={product.source} />
                </div>
              </div>

              {/* Precios */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Precios</h3>
                <div className="so-detail-grid">
                  <Field label="Precio de venta" value={formatCurrency(product.rate, product.currencyCode)} highlighted />
                  <Field label="Costo de compra" value={formatCurrency(product.purchaseRate, product.currencyCode)} />
                </div>
              </div>

              {/* Inventario */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Inventario</h3>
                <div className="so-detail-grid">
                  <Field label="Stock total" value={formatNumber(product.stockOnHand)} />
                  <Field label="Stock disponible" value={formatNumber(product.availableStock)} highlighted />
                  <Field label="Nivel de reorden" value={formatNumber(product.reorderLevel)} />
                </div>
              </div>

              {/* Impuestos */}
              {hasTax ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Impuestos</h3>
                  <div className="so-detail-grid">
                    <Field label="Impuesto" value={product.taxName} />
                    <Field label="Porcentaje" value={product.taxPercentage ? `${product.taxPercentage}%` : null} />
                    <Field label="Gravable" value={product.isTaxable === true ? 'Sí' : product.isTaxable === false ? 'No' : null} />
                    <Field label="Preferencia" value={product.taxPreference} />
                    <Field label="Impuesto de compra" value={product.purchaseTaxName} />
                  </div>
                </div>
              ) : null}

              {/* Fiscal / SAT */}
              {hasSat ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Fiscal / SAT</h3>
                  <div className="so-detail-grid">
                    <Field label="Código SAT" value={product.satProductCode} />
                    <Field label="Unidad SAT" value={product.satUnitCode} />
                  </div>
                </div>
              ) : null}

              {/* Proveedor */}
              {hasVendor ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Proveedor</h3>
                  <div className="so-detail-grid">
                    <Field label="Proveedor" value={product.vendorName} />
                    <Field label="Marca" value={product.brand} />
                    <Field label="Fabricante" value={product.manufacturer} />
                  </div>
                </div>
              ) : null}

              {/* Contabilidad */}
              {hasAccounting ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Contabilidad</h3>
                  <div className="so-detail-grid">
                    <Field label="Cuenta de compra" value={product.purchaseAccountName} />
                    <Field label="Cuenta de venta" value={product.salesAccountName} />
                    <Field label="Cuenta de inventario" value={product.inventoryAccountName} />
                    <Field label="Valuación" value={product.inventoryValuationMethod} />
                  </div>
                </div>
              ) : null}

              {/* Descripción */}
              {product.description ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Descripción</h3>
                  <p style={{ fontSize: '0.875rem', color: 'var(--unik-text-secondary)', whiteSpace: 'pre-wrap' }}>
                    {product.description}
                  </p>
                </div>
              ) : null}

              {/* Sync */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Sincronización</h3>
                <div className="so-detail-grid">
                  <Field label="Últ. modificación remota" value={formatDateTime(product.sourceRemoteModifiedAt)} />
                  <Field label="Normalizado" value={formatDateTime(product.normalizedAt)} />
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
