'use client';

import '@/styles/operations/inventario.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ClipboardList, RefreshCw, ScanLine, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingState } from '@/components/patterns/LoadingState';
import { ScanInput } from '@/components/areas/ScanInput';
import { AreaCopilotPanel } from '@/components/operations/AreaCopilotPanel';
import { useOperationsRealtime } from '@/components/operations/use-operations-realtime';
import { describeSubmitOutcome } from '@/components/operations/mywork-model';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/shadcn/sheet';
import { EmptyState } from '@/components/ui/composite';
import { Alert, Badge, Button, FormField, Select } from '@/components/ui/primitives';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import type { AreaSpecialViewProps } from '@/components/areas/area-client-registry';
import type { WarehouseMap } from '@/modules/areas/inventario/inventory-area-queries';
import type { ScanLookup } from '@/modules/operations/scan-resolver';
import { CountCapture } from './CountCapture';
import { LocationDrawer, type CaptureTarget } from './LocationDrawer';
import {
  CONFIDENCE_ORDER,
  INVENTORY_REALTIME_TYPES,
  INVENTORY_SPACES,
  NEXT_LOCATION_REASONS,
  confidenceLabel,
  confidenceTone,
  formatQty,
  inventoryHref,
  pickNextLocation,
  scanTarget,
  stalenessLabel,
  type LocationLike,
} from './inventario-model';

/**
 * Mapa de ubicaciones (plan 7.6): la bodega dibujada como una cuadrícula de
 * ubicaciones coloreada por confianza, el carril de conteos abiertos, el
 * escaneo y la captura del conteo, con la IA del área al lado.
 *
 * Nothing about the business lives here: the map reads
 * `/api/inventario/map`, the scan uses the shared `/app/operations/api/scan`
 * and every action is a command sent through the offline queue, so a warehouse
 * without signal keeps counting.
 */

const BADGE_BY_TONE = {
  default: 'default',
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  info: 'info',
  weak: 'weak',
} as const;

const MAP_STARTERS = [
  '¿Qué ubicación cuento primero?',
  '¿Qué SKU bloquea más expedientes?',
  '¿Qué conteos están vencidos?',
  '¿Qué está en disputa en esta bodega?',
];

function toLocationLike(location: WarehouseMap['locations'][number]): LocationLike {
  return {
    id: location.id,
    code: location.code,
    label: location.label,
    items: location.items,
    confidence: location.confidence,
    daysSinceCount: location.daysSinceCount,
  };
}

export function LocationsMap({ areaKey, user, canAct, params }: AreaSpecialViewProps) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const { submit, online } = useOfflineCommandQueue(user.id);

  const [map, setMap] = useState<WarehouseMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState<string | null>(params.bodega ?? null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [countId, setCountId] = useState<string | null>(params.count ?? null);
  const [target, setTarget] = useState<CaptureTarget | null>(null);
  const [scanOpen, setScanOpen] = useState(Boolean(params.scan));
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [pendingEvents, setPendingEvents] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const [starting, setStarting] = useState(false);

  const workItemId = params.trabajo ?? null;

  const load = useCallback(
    async (wanted: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const query = wanted ? `?warehouseId=${encodeURIComponent(wanted)}` : '';
        const response = await fetch(
          `/app/areas/${encodeURIComponent(areaKey)}/api/inventario/map${query}`
        );
        const json = (await response.json().catch(() => ({}))) as Partial<WarehouseMap> & {
          error?: string;
        };
        if (!response.ok || !Array.isArray(json.warehouses)) {
          throw new Error(json.error ?? 'No pudimos cargar el mapa de la bodega');
        }
        const value = json as WarehouseMap;
        setMap(value);
        setWarehouseId(value.warehouseId);
        setPendingEvents(0);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'No pudimos cargar el mapa de la bodega');
      } finally {
        setLoading(false);
      }
    },
    [areaKey]
  );

  useEffect(() => {
    void load(warehouseId);
    // The warehouse is changed through `selectWarehouse`, which reloads on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshToken]);

  useOperationsRealtime(
    [`area:${areaKey}`],
    INVENTORY_REALTIME_TYPES,
    useCallback(() => setPendingEvents((value) => value + 1), [])
  );

  const locations = useMemo(() => map?.locations ?? [], [map]);
  const locationLikes = useMemo(() => locations.map(toLocationLike), [locations]);
  const next = useMemo(() => pickNextLocation(locationLikes), [locationLikes]);
  const openCount = useMemo(
    () => map?.openCounts.find((entry) => entry.id === countId) ?? map?.openCounts[0] ?? null,
    [map, countId]
  );
  const activeCountId = countId ?? openCount?.id ?? null;

  const syncUrl = useCallback(
    (next: { bodega?: string | null; count?: string | null }) => {
      router.replace(
        inventoryHref(INVENTORY_SPACES.map, {
          bodega: next.bodega === undefined ? warehouseId : next.bodega,
          count: next.count === undefined ? countId : next.count,
          trabajo: workItemId,
        }),
        { scroll: false }
      );
    },
    [router, warehouseId, countId, workItemId]
  );

  function selectWarehouse(id: string) {
    setWarehouseId(id);
    setLocationId(null);
    setCountId(null);
    setTarget(null);
    syncUrl({ bodega: id, count: null });
    void load(id);
  }

  const applyScan = useCallback(
    (lookup: ScanLookup) => {
      const result = scanTarget(lookup, locationLikes);
      if (result.kind === 'location') {
        setLocationId(result.locationId);
        setScanOpen(false);
        return;
      }
      if (result.kind === 'stock_item' || result.kind === 'sku') {
        const item = lookup.items[0];
        if (!item) return;
        setTarget({
          stockItemId: item.id,
          title: item.title,
          subtitle: item.subtitle,
          unit: item.unit,
        });
        setScanOpen(false);
        return;
      }
      toast.info('No reconocimos ese código en esta bodega.');
    },
    [locationLikes]
  );

  // Deep link from the mobile bar: `/app/areas/inventario/mapa?scan=<código>`.
  useEffect(() => {
    const code = params.scan;
    if (!code || code === '1' || locations.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/app/operations/api/scan?code=${encodeURIComponent(code)}${
            warehouseId ? `&warehouseId=${encodeURIComponent(warehouseId)}` : ''
          }`
        );
        const json = (await response.json().catch(() => ({}))) as { result?: ScanLookup };
        if (!cancelled && json.result) applyScan(json.result);
      } catch {
        /* El panel de escaneo queda abierto para capturarlo a mano. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.scan, locations.length, warehouseId, applyScan]);

  async function startCount() {
    if (!warehouseId || starting) return;
    setStarting(true);
    try {
      const outcome = await submit<
        { warehouseId: string; scope: string },
        { count: { id: string } }
      >({
        type: 'stock.count.start',
        aggregate: { type: 'warehouse', id: warehouseId },
        payload: { warehouseId, scope: 'spot' },
      });
      const feedback = describeSubmitOutcome(outcome, 'Conteo iniciado');
      if (feedback.kind === 'success' && !outcome.queued) {
        const created = outcome.result.data?.count?.id ?? null;
        toast.success(feedback.message);
        if (created) {
          setCountId(created);
          syncUrl({ count: created });
        }
        setRefreshToken((value) => value + 1);
      } else if (feedback.kind === 'queued') {
        toast.info('Sin conexión: el conteo se abrirá en cuanto vuelva la señal.');
      } else {
        toast.error(feedback.message);
      }
    } finally {
      setStarting(false);
    }
  }

  const copilotContext = useCallback(
    () => ({
      surface: 'mapa',
      areaKey,
      warehouseId,
      warehouseName: map?.warehouses.find((entry) => entry.id === warehouseId)?.name ?? null,
      countId: activeCountId,
      locationId,
      locations: locationLikes.slice(0, 25).map((location) => ({
        code: location.code,
        items: location.items,
        confidence: location.confidence,
        daysSinceCount: location.daysSinceCount,
      })),
      openCounts: map?.openCounts.length ?? 0,
      nextLocation: next ? { code: next.location.code, reason: next.reason } : null,
    }),
    [areaKey, warehouseId, map, activeCountId, locationId, locationLikes, next]
  );

  const copilot = (
    <AreaCopilotPanel
      areaKey="inventario"
      user={user}
      activityAt={map?.computedAt ?? null}
      context={copilotContext}
      starters={MAP_STARTERS}
      onAfterTurn={() => setRefreshToken((value) => value + 1)}
      {...(isMobile ? { onBack: () => setCopilotOpen(false) } : {})}
    />
  );

  if (loading && !map) {
    return <LoadingState variant="list" rows={6} label="Cargando el mapa de la bodega…" />;
  }

  if (error && !map) {
    return (
      <ErrorState
        title="No pudimos cargar el mapa"
        message={error}
        onRetry={() => setRefreshToken((value) => value + 1)}
      />
    );
  }

  if (map && map.warehouses.length === 0) {
    return (
      <EmptyState
        icon="building"
        title="Todavía no hay bodegas"
        message="Crea la primera bodega en Ubicaciones: al crearla se genera su ubicación GENERAL y el mapa empieza a funcionar."
        action={
          <a className="btn btn-primary btn-sm" href={inventoryHref(INVENTORY_SPACES.locations)}>
            Ir a Ubicaciones
          </a>
        }
      />
    );
  }

  return (
    <div className="inv-map">
      <div className="inv-map-main">
        <div className="inv-toolbar inv-no-print">
          <FormField label="Bodega" htmlFor="inv-map-warehouse">
            <Select
              id="inv-map-warehouse"
              value={warehouseId ?? ''}
              onChange={(event) => selectWarehouse(event.target.value)}
            >
              {map?.warehouses.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {warehouse.name}
                </option>
              ))}
            </Select>
          </FormField>

          <div className="inv-toolbar-spacer" />

          <Button variant="secondary" size="sm" onClick={() => setScanOpen((value) => !value)}>
            <ScanLine size={14} aria-hidden="true" />
            {scanOpen ? 'Ocultar escaneo' : 'Escanear'}
          </Button>
          {canAct ? (
            <Button size="sm" onClick={startCount} isLoading={starting} disabled={!warehouseId}>
              <ClipboardList size={14} aria-hidden="true" />
              Iniciar conteo
            </Button>
          ) : null}
          {isMobile ? (
            <Button variant="secondary" size="sm" onClick={() => setCopilotOpen(true)}>
              <Sparkles size={14} aria-hidden="true" />
              IA del área
            </Button>
          ) : null}
        </div>

        {pendingEvents > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setRefreshToken((value) => value + 1)}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {pendingEvents === 1
              ? 'Hay 1 movimiento nuevo · Actualizar'
              : `Hay ${pendingEvents} movimientos nuevos · Actualizar`}
          </Button>
        ) : null}

        {!online ? (
          <Alert variant="info">
            Sin conexión: puedes seguir contando; lo capturado se envía solo al volver la señal.
          </Alert>
        ) : null}

        {scanOpen ? (
          <div className="inv-card">
            <ScanInput
              warehouseId={warehouseId}
              autoFocus
              onResolved={applyScan}
              footer={(lookup) =>
                lookup.kind === 'unknown' ? null : (
                  <Button variant="secondary" size="sm" onClick={() => applyScan(lookup)}>
                    Abrir en el mapa
                  </Button>
                )
              }
            />
          </div>
        ) : null}

        {activeCountId ? (
          <CountCapture
            areaKey={areaKey}
            countId={activeCountId}
            user={user}
            canCount={canAct}
            workItemId={workItemId}
            target={target}
            onTargetChange={setTarget}
            onFinished={() => {
              setCountId(null);
              setTarget(null);
              syncUrl({ count: null });
              setRefreshToken((value) => value + 1);
            }}
            onChanged={() => setRefreshToken((value) => value + 1)}
          />
        ) : null}

        <section aria-labelledby="inv-map-grid">
          <h3 id="inv-map-grid" className="area-drawer-section-title">
            Ubicaciones de la bodega
          </h3>
          {locations.length === 0 ? (
            <div className="area-empty">
              <strong>Esta bodega no tiene ubicaciones</strong>
              <p>
                Crea racks, casilleros o patios en Ubicaciones para poder contar por zona. Mientras
                tanto, todo lo que entra se guarda en GENERAL.
              </p>
            </div>
          ) : (
            <>
              <ul className="inv-grid">
                {locations.map((location) => (
                  <li key={location.id}>
                    <button
                      type="button"
                      className={`inv-tile inv-tone-${location.confidence ?? 'UNCOUNTED'}${
                        location.items === 0 ? ' inv-tile-empty' : ''
                      }`}
                      aria-pressed={locationId === location.id}
                      onClick={() => setLocationId(location.id)}
                    >
                      <span className="inv-tile-code">{location.code}</span>
                      <span className="inv-tile-label">{location.label ?? location.kindLabel}</span>
                      <span className="inv-tile-meta">
                        {location.items === 0
                          ? 'Vacía'
                          : `${location.items} ${location.items === 1 ? 'fila' : 'filas'} · ${formatQty(location.known)}`}
                      </span>
                      <span className="inv-tile-meta">
                        {location.confidence
                          ? `${confidenceLabel(location.confidence)} · ${stalenessLabel(location.daysSinceCount)}`
                          : 'Sin existencias'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <ul className="inv-legend">
                {CONFIDENCE_ORDER.map((level) => (
                  <li key={level} className={`inv-legend-${level}`}>
                    <span className="inv-legend-dot" aria-hidden="true" />
                    {confidenceLabel(level)}
                  </li>
                ))}
              </ul>
              {map?.truncated ? (
                <p className="inv-card-hint">
                  Mostramos las primeras ubicaciones de la bodega; usa el escaneo para llegar al
                  resto.
                </p>
              ) : null}
            </>
          )}
        </section>
      </div>

      <aside className="inv-map-aside">
        {next ? (
          <div className="inv-card inv-next">
            <p className="inv-card-title">
              <span>Empieza por {next.location.code}</span>
              <Badge variant={BADGE_BY_TONE[confidenceTone(next.location.confidence)]}>
                {next.location.confidence
                  ? confidenceLabel(next.location.confidence)
                  : 'Sin contar'}
              </Badge>
            </p>
            <p className="inv-card-hint">
              {NEXT_LOCATION_REASONS[next.reason]} · {stalenessLabel(next.location.daysSinceCount)}
            </p>
            <div className="inv-capture-actions">
              <Button size="sm" onClick={() => setLocationId(next.location.id)}>
                Ver la ubicación
              </Button>
            </div>
          </div>
        ) : null}

        <div className="inv-card">
          <p className="inv-card-title">Conteos abiertos</p>
          {map && map.openCounts.length > 0 ? (
            <ul className="inv-list">
              {map.openCounts.map((count) => (
                <li key={count.id} className="inv-list-item">
                  <span className="inv-list-main">
                    <span>
                      {count.scopeLabel} · {count.warehouseName ?? 'Bodega'}
                    </span>
                    <span className="inv-list-sub">
                      {count.lines} {count.lines === 1 ? 'línea' : 'líneas'}
                      {count.outOfTolerance > 0
                        ? ` · ${count.outOfTolerance} fuera de tolerancia`
                        : ''}
                      {count.startedByName ? ` · ${count.startedByName}` : ''}
                    </span>
                  </span>
                  <Button
                    variant={activeCountId === count.id ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={() => {
                      setCountId(count.id);
                      syncUrl({ count: count.id });
                    }}
                  >
                    {activeCountId === count.id ? 'Capturando' : 'Continuar'}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="inv-card-hint">
              No hay conteos abiertos. Inicia uno para capturar lo que ves en el almacén.
            </p>
          )}
        </div>

        {!isMobile ? <div className="inv-card">{copilot}</div> : null}
      </aside>

      {locationId ? (
        <LocationDrawer
          areaKey={areaKey}
          locationId={locationId}
          canCount={canAct}
          activeCountId={activeCountId}
          refreshToken={refreshToken}
          onClose={() => setLocationId(null)}
          onCount={(picked) => {
            if (picked.stockItemId) setTarget(picked);
            setLocationId(null);
          }}
          onStartCount={() => {
            setLocationId(null);
            void startCount();
          }}
        />
      ) : null}

      {isMobile ? (
        <Sheet open={copilotOpen} onOpenChange={setCopilotOpen}>
          <SheetContent side="right" className="w-full max-w-md p-0">
            <SheetTitle className="sr-only">IA de Inventario</SheetTitle>
            <SheetDescription className="sr-only">
              Copiloto del área sobre el mapa y los conteos
            </SheetDescription>
            <div className="area-copilot-sheet">{copilot}</div>
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}
