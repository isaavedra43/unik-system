'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { AlertList } from '@/components/patterns/dashboard/AlertList';
import { ChartCard } from '@/components/patterns/dashboard/ChartCard';
import { KpiGrid } from '@/components/patterns/dashboard/KpiGrid';
import { StatCard } from '@/components/patterns/dashboard/StatCard';
import { StatusStrip } from '@/components/patterns/dashboard/StatusStrip';
import { BarBreakdown, TrendChart } from '@/components/patterns/dashboard/charts';
import { Alert, Button } from '@/components/ui/primitives';
import { relativeSince } from '@/modules/areas/area-time';
import {
  DASHBOARD_LIVE_POLL_MS,
  applyLiveTiles,
  freshnessLabel,
  isDashboardEmpty,
  sourceLabel,
  type LiveTilePatch,
} from '@/modules/areas/dashboard-model';
import type {
  AreaDashboardChart,
  AreaDashboardPayload,
} from '@/modules/areas/area-server-registry';

/**
 * Panel of an area (plan 7.3) in the browser: the tiles, the two charts and the
 * alert list of the payload, with the age of the numbers stated out loud.
 *
 * Two things move here and nowhere else:
 * - the tiles marked `live` are re-read once a minute while the tab is visible
 *   (three indexed counts, never the whole panel);
 * - "Actualizar" recomputes the panel of this area and stores its snapshot, so
 *   the next person through the door reads it already done.
 *
 * Nothing is invented: without a computed panel it says "Sin datos aún" instead
 * of showing zeros that look like real numbers.
 */

export interface AreaDashboardClientProps {
  areaKey: string;
  areaLabel: string;
  payload: AreaDashboardPayload | null;
  note: string | null;
  /** ISO instant the live tiles were computed on the server. */
  liveAt: string | null;
  /** Server time of the render, so the first label matches on hydration. */
  nowIso: string;
}

interface DashboardState {
  payload: AreaDashboardPayload | null;
  note: string | null;
  liveAt: string | null;
}

const CLOCK_INTERVAL_MS = 60_000;

function Chart({ chart }: { chart: AreaDashboardChart }) {
  if (chart.kind === 'trend') {
    const empty =
      chart.data.length === 0 ||
      chart.data.every((point) => chart.series.every((s) => Number(point[s.key] ?? 0) === 0));
    return (
      <ChartCard
        title={chart.title}
        description={chart.description}
        state={empty ? 'empty' : undefined}
        emptyText="Todavía no hay movimiento en este periodo."
      >
        <TrendChart
          data={chart.data}
          series={chart.series}
          xKey={chart.xKey}
          xLabel={chart.xLabel}
          ariaLabel={chart.title}
          // Cuentas de cosas: el eje no ofrece «0.25 expedientes».
          integerY={chart.integerY ?? true}
        />
      </ChartCard>
    );
  }
  if (chart.kind === 'bar') {
    return (
      <ChartCard
        title={chart.title}
        description={chart.description}
        state={chart.data.length === 0 ? 'empty' : undefined}
        emptyText="Sin datos para mostrar."
        height="auto"
      >
        <BarBreakdown
          data={chart.data}
          valueLabel={chart.valueLabel}
          categoryLabel={chart.categoryLabel}
          ariaLabel={chart.title}
        />
      </ChartCard>
    );
  }
  return (
    <ChartCard
      title={chart.title}
      description={chart.description}
      state={chart.segments.length === 0 ? 'empty' : undefined}
      emptyText="Sin datos para mostrar."
      height="auto"
    >
      <StatusStrip segments={chart.segments} label={chart.title} />
    </ChartCard>
  );
}

export function AreaDashboardClient({
  areaKey,
  areaLabel,
  payload,
  note,
  liveAt,
  nowIso,
}: AreaDashboardClientProps) {
  const [state, setState] = useState<DashboardState>({ payload, note, liveAt });
  const [now, setNow] = useState(() => Date.parse(nowIso) || Date.now());
  const [refreshing, setRefreshing] = useState(false);

  // A new server render (router.refresh, navigation) wins over the polled state.
  useEffect(() => {
    setState({ payload, note, liveAt });
  }, [payload, note, liveAt]);

  // The freshness label ages on its own; the clock never touches the numbers.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const pollLiveTiles = useCallback(async () => {
    try {
      const response = await fetch(
        `/app/areas/${encodeURIComponent(areaKey)}/api/dashboard?live=1`
      );
      if (!response.ok) return;
      const data = (await response.json()) as { tiles?: LiveTilePatch[] };
      if (!Array.isArray(data.tiles)) return;
      setState((current) =>
        current.payload
          ? {
              ...current,
              payload: applyLiveTiles(current.payload, data.tiles ?? []),
              liveAt: new Date().toISOString(),
            }
          : current
      );
    } catch {
      // A failed poll keeps the numbers already on screen; the next tick tries again.
    }
  }, [areaKey]);

  useEffect(() => {
    if (!state.payload) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void pollLiveTiles();
    }, DASHBOARD_LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [pollLiveTiles, state.payload]);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const response = await fetch(`/app/areas/${encodeURIComponent(areaKey)}/api/dashboard`, {
        method: 'POST',
      });
      const data = (await response.json().catch(() => ({}))) as {
        accepted?: boolean;
        error?: string;
      };
      if (!response.ok) {
        toast.error(data.error ?? 'No pudimos actualizar los indicadores');
        return;
      }
      setNow(Date.now());
      toast.success('Actualización solicitada');
    } catch {
      toast.error('No pudimos actualizar los indicadores; revisa tu conexión');
    } finally {
      setRefreshing(false);
    }
  }, [areaKey, refreshing]);

  const current = state.payload;
  const liveLabel = useMemo(
    () => (state.liveAt ? relativeSince(state.liveAt, now) : null),
    [state.liveAt, now]
  );

  const refreshButton = (
    <Button
      variant="secondary"
      size="sm"
      onClick={refresh}
      disabled={refreshing}
      title={`Recalcular los indicadores de ${areaLabel}`}
      aria-label={`Recalcular los indicadores de ${areaLabel}`}
    >
      <RefreshCw size={14} className={refreshing ? 'spin' : undefined} aria-hidden="true" />
      {refreshing ? 'Actualizando…' : 'Actualizar'}
    </Button>
  );

  if (isDashboardEmpty(current)) {
    return (
      <div className="area-dashboard">
        {state.note ? <Alert variant="warning">{state.note}</Alert> : null}
        <div className="area-dash-empty">
          <BarChart3 size={24} className="area-dash-empty-icon" aria-hidden="true" />
          <p className="area-dash-empty-title">Sin datos aún</p>
          <p>
            {areaLabel} todavía no tiene indicadores calculados. Se recalculan solos cada pocos
            minutos; también puedes pedirlos ahora.
          </p>
          <div className="area-dash-actions">{refreshButton}</div>
        </div>
      </div>
    );
  }

  const source = sourceLabel(current!.source);

  return (
    <div className="area-dashboard">
      {/*
        UN solo indicador de frescura junto a «Actualizar». Antes había tres
        casi iguales apilados — el chip «En vivo» del encabezado, esta línea y
        otro chip «En vivo hace un momento» — y en teléfono ocupaban tres
        renglones completos antes del primer tile.
      */}
      <div className="area-dashboard-freshness">
        <span className="area-dash-status">
          <span>
            {freshnessLabel(current!.computedAt, now)}
            {source ? ` · ${source}` : ''}
            {liveLabel ? ` · en vivo ${liveLabel}` : ''}
          </span>
          {liveLabel ? (
            <span
              className="area-dash-live-dot"
              aria-hidden="true"
              title="Los indicadores en vivo se recalculan solos"
            />
          ) : null}
        </span>
        <span className="area-dash-actions">{refreshButton}</span>
      </div>

      {state.note ? <Alert variant="warning">{state.note}</Alert> : null}

      {current!.tiles.length > 0 ? (
        <KpiGrid columns={4} aria-label={`Indicadores de ${areaLabel}`}>
          {current!.tiles.slice(0, 8).map((tile) => (
            <StatCard
              key={tile.id}
              label={tile.label}
              value={tile.value}
              hint={tile.hint}
              tone={tile.tone}
              delta={tile.delta}
              href={tile.href}
              live={tile.live}
            />
          ))}
        </KpiGrid>
      ) : null}

      {current!.charts.length > 0 ? (
        <div className="area-dashboard-charts">
          {current!.charts.slice(0, 2).map((chart) => (
            <Chart key={chart.id} chart={chart} />
          ))}
        </div>
      ) : null}

      <ChartCard title="Lo que necesita atención" height="auto">
        <AlertList
          items={current!.alerts.slice(0, 8)}
          emptyText={`${areaLabel} no tiene alertas abiertas.`}
          label={`Alertas de ${areaLabel}`}
          max={6}
        />
      </ChartCard>
    </div>
  );
}
