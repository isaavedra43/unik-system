'use client';

import '@/styles/operations/inventario.css';
import { useCallback, useEffect, useState } from 'react';
import { ClipboardList, Ruler } from 'lucide-react';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingState } from '@/components/patterns/LoadingState';
import Link from 'next/link';
import { Drawer } from '@/components/ui/composite';
import { Alert, Badge, Button } from '@/components/ui/primitives';
import { stockTraceUrl } from '@/modules/areas/manufactura/trace-model';
import type { LocationDetail } from '@/modules/areas/inventario/inventory-area-queries';
import {
  CONFIDENCE_HINTS,
  confidenceLabel,
  confidenceTone,
  formatQty,
  stalenessLabel,
} from './inventario-model';

/**
 * What one location holds (plan 7.6): its confidence, what it stores and the
 * way into a count. It reads `/api/inventario/locations/<id>`, which applies
 * `inventory.view` on the server.
 */

export interface CaptureTarget {
  stockItemId: string;
  title: string;
  subtitle: string;
  unit: string | null;
}

export interface LocationDrawerProps {
  areaKey: string;
  locationId: string;
  /** The person may capture counts (`inventory.count`). */
  canCount: boolean;
  /** Count already open in this warehouse, if any. */
  activeCountId: string | null;
  onClose: () => void;
  /** Captures one stock row in the open count. */
  onCount: (target: CaptureTarget) => void;
  /** Opens a new count for this warehouse. */
  onStartCount: (warehouseId: string) => void;
  /** Version counter: changing it reloads the detail after a command. */
  refreshToken: number;
}

const BADGE_BY_TONE = {
  default: 'default',
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  info: 'info',
  weak: 'weak',
} as const;

export function LocationDrawer({
  areaKey,
  locationId,
  canCount,
  activeCountId,
  onClose,
  onCount,
  onStartCount,
  refreshToken,
}: LocationDrawerProps) {
  const [detail, setDetail] = useState<LocationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/app/areas/${encodeURIComponent(areaKey)}/api/inventario/locations/${encodeURIComponent(locationId)}`
      );
      const json = (await response.json().catch(() => ({}))) as Partial<LocationDetail> & {
        error?: string;
      };
      if (!response.ok || !json.location) {
        throw new Error(json.error ?? 'No pudimos cargar la ubicación');
      }
      setDetail(json as LocationDetail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos cargar la ubicación');
    } finally {
      setLoading(false);
    }
  }, [areaKey, locationId]);

  useEffect(() => {
    void load();
  }, [load, reload, refreshToken]);

  const location = detail?.location ?? null;
  const products = detail?.snapshot.products ?? [];

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={location ? `Ubicación ${location.code}` : 'Ubicación'}
      subtitle={
        location
          ? [location.label, location.kindLabel, detail?.warehouse.name].filter(Boolean).join(' · ')
          : undefined
      }
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cerrar
          </Button>
          {canCount && location ? (
            activeCountId ? (
              <Button
                size="sm"
                onClick={() =>
                  onCount({
                    stockItemId: '',
                    title: `Ubicación ${location.code}`,
                    subtitle: detail?.warehouse.name ?? '',
                    unit: null,
                  })
                }
                disabled={location.items === 0}
              >
                <Ruler size={14} aria-hidden="true" />
                Capturar en el conteo abierto
              </Button>
            ) : (
              <Button size="sm" onClick={() => onStartCount(location.warehouseId)}>
                <ClipboardList size={14} aria-hidden="true" />
                Iniciar conteo
              </Button>
            )
          ) : null}
        </>
      }
    >
      {loading ? (
        <LoadingState variant="list" rows={5} label="Cargando la ubicación…" />
      ) : error ? (
        <ErrorState
          title="No pudimos cargar la ubicación"
          message={error}
          onRetry={() => setReload((value) => value + 1)}
        />
      ) : !location ? (
        <div className="area-empty">
          <strong>Sin datos</strong>
          <p>Esta ubicación ya no está disponible.</p>
        </div>
      ) : (
        <div className="area-drawer-body">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={BADGE_BY_TONE[confidenceTone(location.confidence)]}>
              {location.confidence ? confidenceLabel(location.confidence) : 'Sin existencias'}
            </Badge>
            <span className="area-row-sub">{stalenessLabel(location.daysSinceCount)}</span>
            {!location.active ? <Badge variant="weak">Inactiva</Badge> : null}
          </div>

          {location.confidence ? (
            <Alert variant={location.confidence === 'DISPUTED' ? 'warning' : 'info'}>
              {CONFIDENCE_HINTS[location.confidence]}
            </Alert>
          ) : null}

          <section className="area-drawer-section" aria-labelledby="inv-location-totals">
            <h4 id="inv-location-totals" className="area-drawer-section-title">
              Resumen
            </h4>
            <dl className="area-drawer-fields">
              <div className="area-drawer-field">
                <dt>Filas de existencia</dt>
                <dd>{location.items}</dd>
              </div>
              <div className="area-drawer-field">
                <dt>Conocido</dt>
                <dd>{formatQty(location.known)}</dd>
              </div>
              <div className="area-drawer-field">
                <dt>Reservado</dt>
                <dd>{formatQty(location.reserved)}</dd>
              </div>
              <div className="area-drawer-field">
                <dt>Último conteo</dt>
                <dd>{stalenessLabel(location.daysSinceCount)}</dd>
              </div>
            </dl>
          </section>

          <section className="area-drawer-section" aria-labelledby="inv-location-items">
            <h4 id="inv-location-items" className="area-drawer-section-title">
              Qué guarda
            </h4>
            {products.length === 0 ? (
              <p className="area-row-sub">
                Esta ubicación no tiene existencias registradas. En cuanto se capture un conteo o
                una entrada aparecerán aquí.
              </p>
            ) : (
              <ul className="inv-list">
                {products.flatMap((product) =>
                  product.items.map((item) => (
                    <li key={item.id} className="inv-list-item">
                      <span className="inv-list-main">
                        <span>{product.productName ?? product.sku ?? product.zohoItemId}</span>
                        <span className="inv-list-sub">
                          {[item.variantLabel, item.containerKey, product.confidenceLabel]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <span className="inv-qty">
                        {formatQty(item.known, product.baseUnit)}
                        {Number(item.reserved) > 0
                          ? ` · ${formatQty(item.reserved)} reservado`
                          : ''}
                      </span>
                      {item.originProductionOrderId ? (
                        <Link
                          className="btn btn-secondary btn-sm"
                          href={stockTraceUrl(item.id)}
                          title="Esta existencia salió de una orden de producción"
                        >
                          Trazabilidad
                        </Link>
                      ) : null}
                      {canCount && activeCountId ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            onCount({
                              stockItemId: item.id,
                              title: product.productName ?? product.sku ?? product.zohoItemId,
                              subtitle: [item.variantLabel, item.containerKey, location.code]
                                .filter(Boolean)
                                .join(' · '),
                              unit: product.baseUnit,
                            })
                          }
                        >
                          Contar
                        </Button>
                      ) : null}
                    </li>
                  ))
                )}
              </ul>
            )}
            {detail?.snapshot.truncated ? (
              <p className="area-row-sub">
                Mostramos las primeras filas: usa Existencias para ver el resto.
              </p>
            ) : null}
          </section>
        </div>
      )}
    </Drawer>
  );
}
