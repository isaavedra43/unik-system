'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Workflow } from 'lucide-react';
import { EmptyState } from '@/components/ui/composite';
import { Select } from '@/components/ui/primitives';
import { useIsMobile } from '@/hooks/use-is-mobile';
import {
  areaLegend,
  formatCount,
  formatMinutes,
  formatPercent,
  neuralHref,
  RANGE_PRESETS,
  type DayRange,
} from './neural-model';
import { processStepRows, type ProcessGraphView } from './process-model';
import { StepNode } from './StepNode';

/** React Flow entra al bundle SÓLO aquí (plan 7.8: `dynamic()` en estas rutas). */
const ProcessCanvas = dynamic(() => import('./ProcessCanvas'), {
  ssr: false,
  loading: () => (
    <div className="neural-canvas-loading" role="status">
      <Workflow className="h-5 w-5" aria-hidden="true" />
      Cargando el visor del proceso…
    </div>
  ),
});

export interface ProcessVersionOption {
  id: string;
  processKey: string;
  version: number;
  active: boolean;
  steps: number;
}

export interface ProcessViewerProps {
  versions: readonly ProcessVersionOption[];
  selectedVersionId: string | null;
  view: ProcessGraphView | null;
  /** El proceso tiene un ciclo: no se puede acomodar y hay que decirlo. */
  cycle: readonly string[] | null;
  range: DayRange;
  rangePreset: string | null;
  /** Camino de la variante seleccionada (lo pasa el explorador de variantes). */
  variantLabel?: string | null;
  /** Sin controles de versión ni de rango: el anfitrión ya los tiene. */
  embedded?: boolean;
  /** Parámetros que deben sobrevivir al cambiar de versión o de rango. */
  extraParams?: Record<string, string | null | undefined>;
  /** Selección controlada desde fuera (el explorador de variantes la comparte). */
  selectedStepKey?: string | null;
  onSelectStep?: (stepKey: string | null) => void;
}

/**
 * Visor del proceso definido (plan 7.8a): los pasos de `ProcessVersion` con sus
 * dependencias, coloreados por área y con lo que midieron las proyecciones.
 *
 * SÓLO LECTURA en esta fase: no se edita el proceso desde aquí.
 * En ≤768 px no se monta el lienzo: la misma información se lee como lista.
 */
export function ProcessViewer({
  versions,
  selectedVersionId,
  view,
  cycle,
  range,
  rangePreset,
  variantLabel = null,
  embedded = false,
  extraParams = {},
  selectedStepKey: controlledStepKey,
  onSelectStep,
}: ProcessViewerProps) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [internalStepKey, setInternalStepKey] = useState<string | null>(null);
  const controlled = onSelectStep !== undefined;
  const selectedStepKey = controlled ? (controlledStepKey ?? null) : internalStepKey;
  const selectStep = (key: string | null) => {
    if (onSelectStep) onSelectStep(key);
    else setInternalStepKey(key);
  };

  const rows = useMemo(() => (view ? processStepRows(view) : []), [view]);
  const legend = useMemo(() => areaLegend(rows.map((step) => step.areaKey)), [rows]);
  const selectedStep = rows.find((step) => step.key === selectedStepKey) ?? null;

  const go = (patch: Record<string, string | null>) => {
    router.push(
      neuralHref('procesos', {
        ...extraParams,
        proceso: selectedVersionId,
        rango: rangePreset,
        desde: rangePreset ? null : range.from,
        hasta: rangePreset ? null : range.to,
        ...patch,
      })
    );
  };

  if (versions.length === 0) {
    return (
      <EmptyState
        icon="layers"
        title="Todavía no hay procesos publicados"
        message="El visor dibuja las versiones de proceso del motor de operaciones. En cuanto se publique la primera (por ejemplo, el blueprint de cumplimiento de ventas), aparecerá aquí con sus pasos y sus tiempos."
      />
    );
  }

  return (
    <div className="neural-shell">
      {embedded ? null : (
        <div className="neural-toolbar">
          <div className="neural-toolbar-field">
            <label htmlFor="neural-process-version">Versión del proceso</label>
            <Select
              id="neural-process-version"
              value={selectedVersionId ?? ''}
              onChange={(event) => go({ proceso: event.target.value })}
            >
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.processKey} · v{version.version}
                  {version.active ? ' (activa)' : ''} · {version.steps} pasos
                </option>
              ))}
            </Select>
          </div>
          <div className="neural-toolbar-field">
            <label htmlFor="neural-process-range">Periodo de las métricas</label>
            <Select
              id="neural-process-range"
              value={rangePreset ?? 'custom'}
              onChange={(event) => go({ rango: event.target.value, desde: null, hasta: null })}
            >
              {RANGE_PRESETS.map((preset) => (
                <option key={preset.key} value={preset.key}>
                  {preset.label}
                </option>
              ))}
              {rangePreset === null ? <option value="custom">Rango personalizado</option> : null}
            </Select>
          </div>
          <p className="neural-toolbar-note">
            Las insignias de cada paso salen de las proyecciones del periodo; el dibujo, de la
            definición guardada. El proceso no se edita desde aquí.
          </p>
        </div>
      )}

      {cycle && cycle.length > 0 ? (
        <p className="neural-notice" role="alert">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <span>
            Esta versión del proceso tiene un ciclo ({cycle.join(' → ')}) y no se puede dibujar. Un
            proceso con un ciclo está mal definido: revísalo en el blueprint antes de publicarlo.
          </span>
        </p>
      ) : null}

      {view && view.missingDependencies.length > 0 ? (
        <p className="neural-notice">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <span>
            {view.missingDependencies.length === 1
              ? '1 dependencia apunta a un paso que esta versión no define'
              : `${view.missingDependencies.length} dependencias apuntan a pasos que esta versión no define`}
            :{' '}
            {view.missingDependencies
              .map((entry) => `${entry.step} → ${entry.dependsOn}`)
              .join(', ')}
            . No se dibujan como flechas.
          </span>
        </p>
      ) : null}

      {variantLabel ? (
        <p className="neural-panel-hint">
          Camino resaltado: <strong>{variantLabel}</strong>. Los pasos fuera de la variante se
          atenúan, no se esconden.
        </p>
      ) : null}

      {view === null || rows.length === 0 ? (
        <EmptyState
          icon="layers"
          title="Esta versión no tiene pasos que dibujar"
          message="La definición guardada no trae pasos válidos. Revisa el blueprint publicado o elige otra versión."
        />
      ) : (
        <>
          {legend.length > 0 ? (
            <div className="neural-legend" aria-label="Áreas del proceso">
              {legend.map((entry) => (
                <span key={entry.key} className={`neural-legend-item neural-area-${entry.tone}`}>
                  <span className="neural-legend-dot" aria-hidden="true" />
                  {entry.label}
                </span>
              ))}
            </div>
          ) : null}

          {isMobile ? (
            <ul className="neural-mini-grid" aria-label="Pasos del proceso">
              {rows.map((step) => (
                <li key={step.key}>
                  <StepNode step={step} />
                </li>
              ))}
            </ul>
          ) : (
            <ProcessCanvas
              view={view}
              selectedStepKey={selectedStepKey}
              onSelectStep={selectStep}
              label="Diagrama del proceso: pasos y dependencias"
            />
          )}

          {selectedStep ? (
            <p className="neural-panel-hint" role="status">
              <strong>{selectedStep.label}</strong> · {selectedStep.areaLabel}
              {selectedStep.metrics
                ? ` · ${formatCount(selectedStep.metrics.started)} iniciados, mediana activa ${formatMinutes(
                    selectedStep.metrics.p50ActiveMin
                  )}, espera p90 ${formatMinutes(selectedStep.metrics.p90WaitMin)}`
                : ' · sin mediciones en el periodo'}
            </p>
          ) : null}

          <div className="neural-table-wrap">
            <table className="neural-table">
              <caption className="sr-only">
                Pasos del proceso con sus mediciones del periodo seleccionado
              </caption>
              <thead>
                <tr>
                  <th scope="col">Paso</th>
                  <th scope="col">Área</th>
                  <th scope="col" className="neural-table-num">
                    Iniciados
                  </th>
                  <th scope="col" className="neural-table-num">
                    p50 activo
                  </th>
                  <th scope="col" className="neural-table-num">
                    p90 espera
                  </th>
                  <th scope="col" className="neural-table-num">
                    Incumple
                  </th>
                  <th scope="col" className="neural-table-num">
                    Retrabajo
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((step) => (
                  <tr
                    key={step.key}
                    className={step.key === selectedStepKey ? 'neural-table-row-active' : undefined}
                  >
                    <th scope="row">
                      <button
                        type="button"
                        className="neural-row-button"
                        onClick={() => selectStep(step.key === selectedStepKey ? null : step.key)}
                        aria-pressed={step.key === selectedStepKey}
                      >
                        {step.label}
                      </button>
                    </th>
                    <td>{step.areaLabel}</td>
                    <td className="neural-table-num">
                      {formatCount(step.metrics?.started ?? null)}
                    </td>
                    <td className="neural-table-num">
                      {formatMinutes(step.metrics?.p50ActiveMin ?? null)}
                    </td>
                    <td className="neural-table-num">
                      {formatMinutes(step.metrics?.p90WaitMin ?? null)}
                    </td>
                    <td className="neural-table-num">
                      {formatPercent(step.metrics?.breachPct ?? null)}
                    </td>
                    <td className="neural-table-num">
                      {formatPercent(step.metrics?.reworkPct ?? null)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
