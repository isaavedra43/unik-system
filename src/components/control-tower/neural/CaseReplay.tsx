'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Network, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { KpiGrid } from '@/components/patterns/dashboard/KpiGrid';
import { StatCard } from '@/components/patterns/dashboard/StatCard';
import { EmptyState } from '@/components/ui/composite';
import { Badge, Button, Select } from '@/components/ui/primitives';
import { foldCaseState, type ReplayEvent } from '@/modules/control-tower/replay';
import { CASE_PHASE_LABELS, CASE_STATUS_LABELS } from '@/modules/operations/types';
import { caseHref, formatDateTime, formatDay, neuralHref } from './neural-model';
import {
  atForIndex,
  clampIndex,
  describeFrame,
  initialIndex,
  miniStepViews,
  nextIndex,
  PLAYBACK_INTERVAL_MS,
  replayCounters,
  timelineRows,
  workItemStatusLabel,
  type ReplayTimelineEntry,
} from './replay-model';
import { TimeSlider } from './TimeSlider';

export interface ReplayCaseOption {
  id: string;
  caseNumber: string;
  customerName: string | null;
  openedAt: string;
  status: string;
}

export interface ReplayCaseHeader {
  id: string;
  caseNumber: string;
  customerName: string | null;
  salesOrderNumber: string | null;
  status: string;
  phase: string;
  openedAt: string;
  promisedAt: string | null;
}

export interface CaseReplayProps {
  cases: readonly ReplayCaseOption[];
  caseId: string | null;
  header: ReplayCaseHeader | null;
  /** Bitácora del expediente, con el payload recortado a lo que el estado necesita. */
  events: readonly ReplayEvent[];
  timeline: readonly ReplayTimelineEntry[];
  timestamps: readonly string[];
  /** Etiquetas de paso de la versión del proceso del expediente. */
  stepLabels: Readonly<Record<string, string>>;
  initialAt: string | null;
  /** La bitácora se cortó por tope: hay eventos anteriores. */
  truncated: boolean;
}

/**
 * Reproducción de un expediente (plan 7.8d).
 *
 * La bitácora se trae UNA vez y el estado se reconstruye en el navegador con
 * `foldCaseState` (módulo puro del servidor): por eso el deslizador se mueve al
 * instante y la reproducción puede ir a un evento por segundo sin ir a la red.
 *
 * El estado no sale de ninguna foto guardada: sale de los hechos. Eso es lo que
 * permite rebobinar un expediente que nadie estaba mirando cuando pasó.
 */
/** Estados y fases del expediente en español, como en el Expediente 360. */
function caseStatusLabel(status: string): string {
  return (CASE_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

function casePhaseLabel(phase: string): string {
  return (CASE_PHASE_LABELS as Record<string, string>)[phase] ?? phase;
}

export function CaseReplay({
  cases,
  caseId,
  header,
  events,
  timeline,
  timestamps,
  stepLabels,
  initialAt,
  truncated,
}: CaseReplayProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [index, setIndex] = useState(() => initialIndex(timestamps, initialAt));
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setIndex(initialIndex(timestamps, initialAt));
    setPlaying(false);
  }, [timestamps, initialAt]);

  useEffect(() => {
    if (!playing) return;
    timer.current = setInterval(() => {
      setIndex((current) => {
        const next = nextIndex(current, timestamps.length);
        if (next === null) {
          setPlaying(false);
          return current;
        }
        return next;
      });
    }, PLAYBACK_INTERVAL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [playing, timestamps.length]);

  const at = atForIndex(timestamps, index);
  const state = useMemo(() => foldCaseState(events, at), [events, at]);
  const labels = useMemo(() => new Map(Object.entries(stepLabels)), [stepLabels]);
  const steps = useMemo(() => miniStepViews(state, labels), [state, labels]);
  const rows = useMemo(() => timelineRows(timeline, at), [timeline, at]);
  const counters = replayCounters(state);
  const openWorkItems = state.workItems.filter(
    (item) => item.status !== 'done' && item.status !== 'cancelled'
  );

  const picker = (
    <div className="neural-toolbar">
      <div className="neural-toolbar-field">
        <label htmlFor="neural-replay-case">Expediente</label>
        <Select
          id="neural-replay-case"
          value={caseId ?? ''}
          onChange={(event) =>
            startTransition(() =>
              router.push(neuralHref('replay', { caso: event.target.value || null }))
            )
          }
        >
          <option value="">Elige un expediente…</option>
          {cases.map((option) => (
            <option key={option.id} value={option.id}>
              {option.caseNumber}
              {option.customerName ? ` · ${option.customerName}` : ''} ·{' '}
              {formatDay(option.openedAt)}
            </option>
          ))}
        </Select>
      </div>
      {header ? (
        <div className="neural-toolbar-actions">
          <Link className="btn btn-ghost btn-sm" href={caseHref(header.id)}>
            Abrir el expediente
          </Link>
          <Link
            className="btn btn-ghost btn-sm"
            href={neuralHref('grafo', {
              perspectiva: 'expediente',
              tipo: 'operational_case',
              raiz: header.id,
            })}
          >
            <Network className="h-4 w-4" aria-hidden="true" /> Ver en el grafo
          </Link>
        </div>
      ) : null}
      <p className="neural-toolbar-note">
        Se listan los expedientes más recientes. Si buscas uno viejo, ábrelo desde el grafo o desde
        la lista de expedientes y vuelve aquí con «Abrir en replay».
      </p>
    </div>
  );

  if (!caseId || !header) {
    return (
      <div className="neural-shell">
        {picker}
        <EmptyState
          icon="fileText"
          title="Elige un expediente para rebobinarlo"
          message="La reproducción reconstruye el estado del expediente en cualquier momento de su historia: fase, pasos, trabajos, solicitudes e incidencias, tal como estaban."
        />
      </div>
    );
  }

  if (timestamps.length === 0) {
    return (
      <div className="neural-shell">
        {picker}
        <EmptyState
          icon="fileText"
          title="Este expediente todavía no tiene historia"
          message="No hay eventos de negocio registrados para reproducir. Aparecerán en cuanto el expediente empiece a moverse."
        />
      </div>
    );
  }

  return (
    <div className="neural-shell">
      {picker}

      <div className="neural-panel">
        <div className="neural-panel-head">
          <h2 className="neural-panel-title">
            {header.caseNumber}
            {header.customerName ? ` · ${header.customerName}` : ''}
          </h2>
          <span className="neural-legend">
            <Badge
              variant={
                state.status === 'cancelled'
                  ? 'danger'
                  : state.status === 'closed'
                    ? 'success'
                    : 'info'
              }
            >
              {caseStatusLabel(state.status)}
            </Badge>
            <span>Fase: {casePhaseLabel(state.phase)}</span>
            {header.promisedAt ? <span>Prometido: {formatDateTime(header.promisedAt)}</span> : null}
            {header.salesOrderNumber ? <span>OV {header.salesOrderNumber}</span> : null}
          </span>
        </div>

        <TimeSlider
          label="Instante reproducido"
          value={index}
          min={0}
          max={Math.max(0, timestamps.length - 1)}
          onChange={(value) => {
            setPlaying(false);
            setIndex(clampIndex(value, timestamps.length));
          }}
          formatValue={() => describeFrame(state, index, timestamps.length)}
          minLabel={formatDateTime(timestamps[0] ?? null)}
          maxLabel={formatDateTime(timestamps[timestamps.length - 1] ?? null)}
          description="Mueve el deslizador con ←/→ o reproduce la historia a un evento por segundo."
          actions={
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPlaying(false);
                  setIndex((current) => clampIndex(current - 1, timestamps.length));
                }}
                disabled={index === 0}
                aria-label="Evento anterior"
                icon={<SkipBack className="h-4 w-4" />}
              >
                Anterior
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  if (!playing && index >= timestamps.length - 1) setIndex(0);
                  setPlaying((current) => !current);
                }}
                icon={playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              >
                {playing ? 'Pausar' : 'Reproducir'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPlaying(false);
                  setIndex((current) => clampIndex(current + 1, timestamps.length));
                }}
                disabled={index >= timestamps.length - 1}
                aria-label="Evento siguiente"
                icon={<SkipForward className="h-4 w-4" />}
              >
                Siguiente
              </Button>
            </>
          }
        />
      </div>

      <KpiGrid columns={4}>
        {counters.map((tile) => (
          <StatCard
            key={tile.key}
            label={tile.label}
            value={tile.value}
            tone={tile.tone}
            {...(tile.hint ? { hint: tile.hint } : {})}
          />
        ))}
      </KpiGrid>

      <div className="neural-split">
        <section className="neural-panel" aria-labelledby="neural-replay-steps">
          <div className="neural-panel-head">
            <h2 className="neural-panel-title" id="neural-replay-steps">
              El proceso en ese momento
            </h2>
            <p className="neural-panel-hint">{describeFrame(state, index, timestamps.length)}</p>
          </div>
          {steps.length === 0 ? (
            <p className="neural-panel-hint">
              En ese instante todavía no había pasos abiertos en el expediente.
            </p>
          ) : (
            <ul className="neural-mini-grid" aria-label="Pasos del expediente en ese instante">
              {steps.map((step) => (
                <li key={step.ref} className={`neural-mini-step neural-state-${step.tone}`}>
                  <span className="neural-mini-step-title">{step.label}</span>
                  <span className="neural-mini-step-meta">
                    {step.areaLabel} · {step.statusLabel}
                  </span>
                  {step.waitReason ? (
                    <span className="neural-mini-step-meta">Espera: {step.waitReason}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {openWorkItems.length > 0 ? (
            <>
              <p className="neural-panel-hint">Trabajos abiertos en ese instante</p>
              <ul className="neural-sim-list">
                {openWorkItems.slice(0, 12).map((item) => (
                  <li key={item.id} className="neural-sim-chip">
                    <span>{item.title || 'Trabajo sin título'}</span>
                    <span>{workItemStatusLabel(item.status)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        <aside className="neural-split-aside" aria-labelledby="neural-replay-timeline">
          <div className="neural-panel">
            <div className="neural-panel-head">
              <h2 className="neural-panel-title" id="neural-replay-timeline">
                Cronología
              </h2>
            </div>
            {truncated ? (
              <p className="neural-panel-hint">
                Este expediente tiene más eventos de los que caben en una lectura: se muestran los
                más recientes.
              </p>
            ) : null}
            <ol className="neural-timeline">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className={`neural-timeline-item${row.future ? ' neural-timeline-item-future' : ''}${
                    row.current ? ' neural-timeline-item-current' : ''
                  }`}
                  {...(row.current ? { 'aria-current': 'step' as const } : {})}
                >
                  <span className="neural-timeline-clock">{row.clock}</span>
                  <span className="neural-timeline-line">{row.line}</span>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>
    </div>
  );
}
