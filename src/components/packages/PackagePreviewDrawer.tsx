'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellRing, ExternalLink, MapPin, X } from 'lucide-react';
import { toast } from 'sonner';
import type { PackageDetail } from '@/modules/packages/packages-contract';
import { formatCurrency, formatDateOnly } from '@/modules/packages/packages-helpers';
import { getSalesOrderStatusConfig } from '@/modules/sales/sales-orders-helpers';
import {
  PackageAddress,
  PackageItemsTable,
  PackagePdfActions,
  PackageShipmentFacts,
  PackageStatusBadge,
  PackageSteps,
  PackageZohoRefresh,
  RelatedLink,
} from './package-view';

type WatchAction = (
  prevState: { error: string | null; success: boolean; isWatched: boolean },
  formData: FormData
) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;

interface PreviewDrawerProps {
  packageId: string;
  basePath: string;
  entityLabel: string;
  onClose: () => void;
  canWatch: boolean;
  isWatched: boolean;
  onWatchChange: (watched: boolean) => void;
  watchAction: WatchAction;
  unwatchAction: WatchAction;
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
      toast.success(
        watched ? `Dejaste de seguir el ${entityLabel.toLowerCase()}` : `${entityLabel} seguido`
      );
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  const salesOrderNumber =
    pkg?.relatedSalesOrder?.salesOrderNumber ?? pkg?.salesorderNumber ?? null;

  return (
    <>
      <div className="overlay" onClick={onClose} aria-hidden="true" />
      <aside
        className="so-detail-drawer pkg-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Detalle de ${entityLabel.toLowerCase()}`}
      >
        <div className="so-detail-header pkg-drawer-head">
          <div className="pkg-drawer-title">
            <p className="pkg-kicker">
              {entityLabel}
              {salesOrderNumber ? ` · ${salesOrderNumber}` : ''}
            </p>
            <h2>{pkg?.packageNumber ?? (loading ? 'Cargando…' : '—')}</h2>
            <div className="pkg-drawer-sub">
              {pkg ? <PackageStatusBadge status={pkg.status} /> : null}
              {pkg?.customerName ? <span>{pkg.customerName}</span> : null}
              {pkg?.date ? <span className="text-muted">{formatDateOnly(pkg.date)}</span> : null}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>

        <div className="pkg-drawer-actions">
          {canWatch ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleWatch}
              aria-pressed={watched}
            >
              {watched ? (
                <BellRing size={14} aria-hidden="true" />
              ) : (
                <Bell size={14} aria-hidden="true" />
              )}
              {watched ? 'Siguiendo' : 'Seguir'}
            </button>
          ) : null}
          <PackagePdfActions pkgId={packageId} basePath={basePath} />
          <button
            type="button"
            className="btn btn-primary btn-sm pkg-drawer-open"
            onClick={() => router.push(`${basePath}/${packageId}`)}
          >
            <ExternalLink size={14} aria-hidden="true" /> Abrir
          </button>
        </div>

        <div className="so-detail-body pkg-drawer-body">
          {loading ? (
            <div className="pkg-drawer-loading" aria-busy="true">
              <span className="calls-skel is-title" />
              <span className="calls-skel is-block" />
              <span className="calls-skel" style={{ width: '70%' }} />
            </div>
          ) : error ? (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          ) : pkg ? (
            <>
              <PackageZohoRefresh pkg={pkg} basePath={basePath} onRefreshed={setPkg} />
              <PackageSteps pkg={pkg} compact />

              <section className="pkg-drawer-section">
                <h3 className="so-detail-section-title">Envío</h3>
                <PackageShipmentFacts pkg={pkg} />
              </section>

              <section className="pkg-drawer-section">
                <div className="pkg-card-head">
                  <h3 className="so-detail-section-title" style={{ marginBottom: 0 }}>
                    Contenido
                  </h3>
                  {pkg.items.length > 0 ? (
                    <span className="pkg-count">{pkg.items.length}</span>
                  ) : null}
                </div>
                <PackageItemsTable pkg={pkg} compact />
              </section>

              <section className="pkg-drawer-section">
                <h3 className="so-detail-section-title">
                  <MapPin size={12} aria-hidden="true" /> Dirección de envío
                </h3>
                <PackageAddress pkg={pkg} />
              </section>

              {pkg.relatedSalesOrder || pkg.relatedContact ? (
                <section className="pkg-drawer-section">
                  <h3 className="so-detail-section-title">Relacionados</h3>
                  <div className="pkg-related-list">
                    {pkg.relatedSalesOrder ? (
                      <RelatedLink
                        href={`/app/sales/orders/${pkg.relatedSalesOrder.id}`}
                        title={`Orden ${pkg.relatedSalesOrder.salesOrderNumber ?? '—'}`}
                        meta={[
                          getSalesOrderStatusConfig(pkg.relatedSalesOrder.status, 'order').label,
                          pkg.relatedSalesOrder.total
                            ? formatCurrency(pkg.relatedSalesOrder.total)
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      />
                    ) : null}
                    {pkg.relatedContact?.id ? (
                      <RelatedLink
                        href={`/app/contacts/customers/${pkg.relatedContact.id}`}
                        title={pkg.relatedContact.contactName ?? pkg.customerName ?? 'Cliente'}
                        meta={
                          pkg.relatedContact.companyName ?? pkg.relatedContact.contactType ?? null
                        }
                      />
                    ) : null}
                  </div>
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </aside>
    </>
  );
}
