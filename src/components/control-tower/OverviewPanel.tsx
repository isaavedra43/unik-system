'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { ControlTowerCopilotPanel } from '@/components/operations/ControlTowerCopilotPanel';
import { AlertList } from '@/components/patterns/dashboard/AlertList';
import { ChartCard } from '@/components/patterns/dashboard/ChartCard';
import { KpiGrid } from '@/components/patterns/dashboard/KpiGrid';
import { StatCard } from '@/components/patterns/dashboard/StatCard';
import { StatusStrip } from '@/components/patterns/dashboard/StatusStrip';
import { BarBreakdown, TrendChart } from '@/components/patterns/dashboard/charts';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/shadcn/sheet';
import { Alert, Badge, Button } from '@/components/ui/primitives';
import { relativeSince } from '@/modules/areas/area-time';
import { freshnessLabel } from '@/modules/areas/dashboard-model';
import type { AreaDashboardChart } from '@/modules/areas/area-server-registry';
import type { ControlTowerOverview } from '@/modules/control-tower/control-tower-service';
import { HealthList, type HealthListItem } from './HealthList';
import { ProjectionsRebuildButton } from './ProjectionsRebuildButton';
import { useWideScreen } from './use-wide-screen';
import { controlTowerHref } from './control-tower-views';
import {
  areaLoadTone,
  buildControlTowerContext,
  formatCount,
  formatUsd,
  jobsTone,
  minutesAgoLabel,
  orderSyncRuns,
  projectionLabel,
  projectionTone,
  sortedAreaLoad,
  syncHealthCaption,
  syncStatusLabel,
  syncTone,
} from './overview-model';

/**
 * Summary of the Control Tower (plan 7.7 `resumen`): the eight KPIs, the phase
 * strip, the activity of the last 24 hours, what is overdue by area, the alert
 * list and the technical health (Zoho sync, background jobs, AI cost and the
 * freshness of the projections), with the administrator copilot beside it.
 *
 * Nothing is computed here: the whole payload comes from
 * `control-tower-service` and "Actualizar" asks the same route for a fresh one
 * (`?fresh=1`). The age of the numbers is always stated out loud, so a snapshot
 * is never mistaken for this second's truth.
 */

export interface OverviewPanelProps {
  user: { id: string; name: string };
  overview: ControlTowerOverview | null;
  /** `snapshot` = stored by the dashboards job; `live` = computed now. */
  source: 'snapshot' | 'live';
  /** Spanish note when the summary could not be computed. */
  note: string | null;
  canUseAssistant: boolean;
  /** Latest movement of the operation, the copilot's re-analysis anchor. */
  activityAt: string | null;
  nowIso: string;
}

const CLOCK_INTERVAL_MS = 60_000;

function ChartBlock({ chart }: { chart: AreaDashboardChart }) {
  if (chart.kind === 'trend') {
    const empty =
      chart.data.length === 0 ||
      chart.data.every((point) =>
        chart.series.every((serie) => Number(point[serie.key] ?? 0) === 0)
      );
    return (
      <ChartCard
        title={chart.title}
        description={chart.description}
        state={empty ? 'empty' : undefined}
        emptyText="No hubo movimiento en este periodo."
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
        emptyText="Ningún área tiene vencidos ahora mismo."
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
      emptyText="Sin expedientes abiertos."
      height="auto"
    >
      <StatusStrip segments={chart.segments} label={chart.title} />
    </ChartCard>
  );
}

export function OverviewPanel({
  user,
  overview,
  source,
  note,
  canUseAssistant,
  activityAt,
  nowIso,
}: OverviewPanelProps) {
  const [state, setState] = useState<{
    overview: ControlTowerOverview | null;
    source: 'snapshot' | 'live';
  }>({ overview, source });
  const [now, setNow] = useState(() => Date.parse(nowIso) || Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const wide = useWideScreen();

  // A new server render wins over whatever "Actualizar" left on screen.
  useEffect(() => {
    setState({ overview, source });
  }, [overview, source]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const response = await fetch('/app/admin/control-tower/api/overview?fresh=1');
      const data = (await response.json().catch(() => ({}))) as {
        overview?: ControlTowerOverview;
        error?: string;
      };
      if (!response.ok || !data.overview) {
        toast.error(data.error ?? 'No pudimos actualizar el resumen');
        return;
      }
      setState({ overview: data.overview, source: 'live' });
      setNow(Date.now());
      toast.success('Resumen actualizado');
    } catch {
      toast.error('No pudimos actualizar el resumen; revisa tu conexión');
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  const current = state.overview;

  const copilotContext = useCallback(
    () => (current ? buildControlTowerContext(current, 'resumen') : { surface: 'control_tower' }),
    [current]
  );

  const copilot = canUseAssistant ? (
    <ControlTowerCopilotPanel
      user={user}
      activityAt={activityAt}
      context={copilotContext}
      {...(wide === false ? { onBack: () => setCopilotOpen(false) } : {})}
    />
  ) : null;

  const areas = useMemo(() => (current ? sortedAreaLoad(current.areas) : []), [current]);

  const refreshButton = (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => void refresh()}
      disabled={refreshing}
      aria-label="Recalcular el resumen de la operación"
    >
      <RefreshCw size={14} className={refreshing ? 'spin' : undefined} aria-hidden="true" />
      {refreshing ? 'Actualizando…' : 'Actualizar'}
    </Button>
  );

  if (!current) {
    return (
      <div className="ct-overview">
        <div className="ct-overview-main">
          {note ? <Alert variant="warning">{note}</Alert> : null}
          <div className="ct-empty">
            <strong>Sin datos aún</strong>
            <p>
              Todavía no hay un resumen calculado de la operación. Se recalcula solo cada pocos
              minutos; también puedes pedirlo ahora.
            </p>
            <div className="ct-actions">{refreshButton}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ct-overview">
      <div className="ct-overview-main">
        <div className="ct-freshness">
          <span className="ct-freshness-status">
            <span>
              {freshnessLabel(current.computedAt, now)}
              {state.source === 'snapshot' ? ' · desde la última proyección' : ' · calculado ahora'}
            </span>
            {activityAt ? (
              <span title="Último movimiento registrado en un expediente abierto">
                Último movimiento {relativeSince(activityAt, now)}
              </span>
            ) : null}
          </span>
          <span className="ct-actions">
            {canUseAssistant && wide === false ? (
              <Button variant="secondary" size="sm" onClick={() => setCopilotOpen(true)}>
                <Sparkles size={14} aria-hidden="true" />
                IA de la operación
              </Button>
            ) : null}
            {refreshButton}
          </span>
        </div>

        {note ? <Alert variant="warning">{note}</Alert> : null}

        <KpiGrid columns={4} aria-label="Indicadores de la operación">
          {current.tiles.slice(0, 8).map((tile) => (
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

        <div className="ct-charts">
          {current.charts.slice(0, 2).map((chart) => (
            <ChartBlock key={chart.id} chart={chart} />
          ))}
        </div>

        {current.charts.length > 2 ? <ChartBlock chart={current.charts[2]} /> : null}

        <ChartCard title="Lo que necesita atención" height="auto">
          <AlertList
            items={current.alerts}
            emptyText="La operación no tiene alertas abiertas."
            label="Alertas de la operación"
            max={6}
            moreHref={controlTowerHref('excepciones')}
          />
        </ChartCard>

        <ChartCard
          title="Carga por área"
          description="Ordenado por presión: primero lo vencido, luego las incidencias."
          height="auto"
          actions={
            <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={refreshing}>
              Recalcular
            </Button>
          }
        >
          <div className="ct-table-scroll">
            <table className="table">
              <caption className="sr-only">Trabajo y solicitudes por área</caption>
              <thead>
                <tr>
                  <th scope="col">Área</th>
                  <th scope="col">Trabajo abierto</th>
                  <th scope="col">Vencido</th>
                  <th scope="col">Solicitudes</th>
                  <th scope="col">Incidencias</th>
                  <th scope="col">IA hoy</th>
                </tr>
              </thead>
              <tbody>
                {areas.map((area) => (
                  <tr key={area.areaKey}>
                    <th scope="row" className="ct-cell-strong">
                      {area.label}
                    </th>
                    <td className="ct-numeric">{formatCount(area.openWorkItems)}</td>
                    <td className="ct-numeric">
                      {area.overdueWorkItems > 0 ? (
                        <Badge variant={areaLoadTone(area) === 'danger' ? 'danger' : 'warning'}>
                          {formatCount(area.overdueWorkItems)}
                        </Badge>
                      ) : (
                        <span className="text-muted">0</span>
                      )}
                    </td>
                    <td className="ct-numeric">
                      {formatCount(area.openRequests)}
                      {area.overdueRequests > 0 ? (
                        <span className="ct-cell-sub">
                          {formatCount(area.overdueRequests)} vencidas
                        </span>
                      ) : null}
                    </td>
                    <td className="ct-numeric">
                      {area.openIncidents > 0 ? (
                        <Badge variant="warning">{formatCount(area.openIncidents)}</Badge>
                      ) : (
                        <span className="text-muted">0</span>
                      )}
                    </td>
                    <td className="ct-numeric">
                      {area.aiUsd !== null && area.aiUsd > 0
                        ? formatUsd(area.aiUsd)
                        : area.aiTokens !== null && area.aiTokens > 0
                          ? `${formatCount(area.aiTokens)} ${area.aiTokens === 1 ? 'token' : 'tokens'}`
                          : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>

        <div className="ct-health">
          <ChartCard
            title="Sincronización con Zoho"
            description={syncHealthCaption(current.sync)}
            height="auto"
          >
            <HealthList
              label="Corridas de sincronización"
              emptyText="Todavía no hay corridas registradas."
              max={8}
              items={orderSyncRuns(current.sync.runs).map((run) => ({
                id: `${run.source}:${run.entityType}`,
                label: run.entityType,
                hint: run.source,
                tone: syncTone(run),
                value: `${syncStatusLabel(run.status)} · ${minutesAgoLabel(run.minutesAgo)}`,
              }))}
            />
          </ChartCard>

          <ChartCard
            title="Trabajos de fondo"
            description="Cola de jobs del sistema."
            height="auto"
          >
            <HealthList
              label="Cola de trabajos de fondo"
              emptyText="La cola está vacía."
              items={[
                { id: 'pending', label: 'Pendientes', value: formatCount(current.jobs.pending) },
                { id: 'running', label: 'En curso', value: formatCount(current.jobs.running) },
                {
                  id: 'failed',
                  label: 'Fallidos',
                  tone: jobsTone(current.jobs),
                  value: formatCount(current.jobs.failed),
                },
                {
                  id: 'completed',
                  label: 'Terminados',
                  value: formatCount(current.jobs.completed),
                },
              ]}
            />
          </ChartCard>

          <ChartCard
            title="Proyecciones e IA"
            description="Frescura de la minería de procesos y consumo de la IA."
            height="auto"
            actions={<ProjectionsRebuildButton onDone={() => void refresh()} />}
          >
            <HealthList
              label="Proyecciones y consumo de IA"
              emptyText="Sin proyecciones ni consumo registrado."
              items={[
                ...(current.projections.length === 0
                  ? [
                      {
                        id: 'projections',
                        label: 'Proyecciones',
                        value: 'Sin corridas todavía',
                      } satisfies HealthListItem,
                    ]
                  : current.projections.map((row) => ({
                      id: row.key,
                      label: projectionLabel(row.key),
                      tone: projectionTone(row),
                      value: minutesAgoLabel(row.minutesAgo),
                    }))),
                {
                  id: 'ai',
                  label: 'IA hoy',
                  hint: 'Todas las áreas',
                  value:
                    current.ai.usdToday > 0
                      ? formatUsd(current.ai.usdToday)
                      : `${formatCount(current.ai.tokensToday)} ${
                          current.ai.tokensToday === 1 ? 'token' : 'tokens'
                        }`,
                },
              ]}
            />
          </ChartCard>
        </div>

        <ChartCard
          title="Quién carga lo vencido"
          description="Personas con más trabajo pasado de fecha."
          height="auto"
        >
          <HealthList
            label="Personas con trabajo vencido"
            emptyText="Nadie tiene trabajo vencido ahora mismo."
            items={current.overdueByOwner.map((row) => ({
              id: row.userId,
              label: row.name ?? 'Persona sin nombre',
              tone: 'danger' as const,
              value: row.overdue === 1 ? '1 vencido' : `${formatCount(row.overdue)} vencidos`,
            }))}
          />
        </ChartCard>
      </div>

      {copilot ? <aside className="ct-overview-aside">{copilot}</aside> : null}

      {copilot && wide === false ? (
        <Sheet open={copilotOpen} onOpenChange={setCopilotOpen}>
          <SheetContent side="right" className="w-full max-w-md p-0">
            <SheetTitle className="sr-only">IA de la operación</SheetTitle>
            <SheetDescription className="sr-only">
              Copiloto del Control Tower sobre los indicadores visibles
            </SheetDescription>
            <div className="ct-copilot-sheet">{copilot}</div>
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}
