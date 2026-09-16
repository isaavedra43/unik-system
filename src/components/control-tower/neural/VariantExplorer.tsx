'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { GitBranch } from 'lucide-react';
import { KpiGrid } from '@/components/patterns/dashboard/KpiGrid';
import { StatCard } from '@/components/patterns/dashboard/StatCard';
import { EmptyState } from '@/components/ui/composite';
import { Select } from '@/components/ui/primitives';
import { AREA_KEYS, AREA_LABELS } from '@/modules/operations/types';
import type { ProcessLayout } from '@/modules/control-tower/process-layout';
import type {
  CausesView,
  HandoffsView,
  StepMetricsView,
  VariantsView,
} from '@/modules/control-tower/projections-service';
import { BottleneckRanking } from './BottleneckRanking';
import { CauseTable } from './CauseTable';
import { HandoffMatrix } from './HandoffMatrix';
import {
  conformanceTone,
  formatCount,
  formatMinutes,
  formatPercent,
  neuralHref,
  RANGE_PRESETS,
  type DayRange,
} from './neural-model';
import { buildProcessView } from './process-model';
import { ProcessViewer, type ProcessVersionOption } from './ProcessViewer';
import { ReworkList } from './ReworkList';

export interface VariantExplorerProps {
  variants: VariantsView;
  stepMetrics: StepMetricsView;
  handoffs: HandoffsView;
  causes: CausesView;
  /** Acomodo de la versión seleccionada; `null` si no se pudo dibujar. */
  layout: ProcessLayout | null;
  cycle: readonly string[] | null;
  versions: readonly ProcessVersionOption[];
  selectedVersionId: string | null;
  range: DayRange;
  rangePreset: string | null;
  areaKey: string | null;
  handoffKind: HandoffsView['kind'];
  causeType: string | null;
}

/**
 * Explorador de variantes (plan 7.8b): los caminos que de verdad recorrieron
 * los expedientes, con sus tiempos y su conformidad, y las cuatro lecturas que
 * explican dónde se pierde el tiempo — cuellos de botella, retrabajo, traspasos
 * entre áreas y causas de bloqueo.
 *
 * Elegir una variante RESALTA su camino en el visor del proceso, que es la
 * pregunta que de verdad se hace la gente: "¿por dónde se fueron estos?".
 *
 * Todo sale de las proyecciones (`ct.projections_refresh`), no de la bitácora:
 * por eso responde aunque haya millones de eventos, y por eso la frescura se
 * muestra al pie de la página.
 */
export function VariantExplorer({
  variants,
  stepMetrics,
  handoffs,
  causes,
  layout,
  cycle,
  versions,
  selectedVersionId,
  range,
  rangePreset,
  areaKey,
  handoffKind,
  causeType,
}: VariantExplorerProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [variantHash, setVariantHash] = useState<string | null>(null);
  const [stepKey, setStepKey] = useState<string | null>(null);

  const selectedVariant =
    variants.variants.find((entry) => entry.variantHash === variantHash) ?? null;

  const processView = useMemo(
    () =>
      layout
        ? buildProcessView({
            layout,
            metrics: stepMetrics.steps,
            path: selectedVariant?.sequence ?? [],
          })
        : null,
    [layout, stepMetrics.steps, selectedVariant]
  );

  const go = (patch: Record<string, string | null>) => {
    startTransition(() => {
      router.push(
        neuralHref('variantes', {
          proceso: selectedVersionId,
          rango: rangePreset,
          desde: rangePreset ? null : range.from,
          hasta: rangePreset ? null : range.to,
          area: areaKey,
          traspaso: handoffKind === 'all' ? null : handoffKind,
          causa: causeType,
          ...patch,
        })
      );
    });
  };

  return (
    <div className="neural-shell">
      <div className="neural-toolbar">
        <div className="neural-toolbar-field">
          <label htmlFor="neural-variants-version">Versión del proceso</label>
          <Select
            id="neural-variants-version"
            value={selectedVersionId ?? ''}
            onChange={(event) => go({ proceso: event.target.value })}
            disabled={versions.length === 0}
          >
            {versions.length === 0 ? <option value="">Sin versiones publicadas</option> : null}
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.processKey} · v{version.version}
                {version.active ? ' (activa)' : ''}
              </option>
            ))}
          </Select>
        </div>

        <div className="neural-toolbar-field">
          <label htmlFor="neural-variants-range">Periodo</label>
          <Select
            id="neural-variants-range"
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

        <div className="neural-toolbar-field">
          <label htmlFor="neural-variants-area">Área</label>
          <Select
            id="neural-variants-area"
            value={areaKey ?? ''}
            onChange={(event) => go({ area: event.target.value || null })}
          >
            <option value="">Todas las áreas</option>
            {AREA_KEYS.map((key) => (
              <option key={key} value={key}>
                {AREA_LABELS[key]}
              </option>
            ))}
          </Select>
        </div>

        <div className="neural-toolbar-field">
          <label htmlFor="neural-variants-handoff">Traspasos</label>
          <Select
            id="neural-variants-handoff"
            value={handoffKind}
            onChange={(event) => go({ traspaso: event.target.value })}
          >
            <option value="all">Solicitudes y reasignaciones</option>
            <option value="request">Sólo solicitudes entre áreas</option>
            <option value="workitem">Sólo reasignaciones de trabajo</option>
          </Select>
        </div>

        <p className="neural-toolbar-note">
          El filtro de área afecta a las métricas por paso y al ranking de cuellos de botella; las
          variantes y los traspasos son del proceso completo, porque un camino cruza áreas.
        </p>
      </div>

      <KpiGrid columns={4}>
        <StatCard
          label="Expedientes del periodo"
          value={formatCount(variants.cases)}
          hint={variants.truncated ? 'Se leyó sólo una parte: acorta el rango' : undefined}
          tone={variants.truncated ? 'warning' : 'default'}
        />
        <StatCard
          label="Siguieron el proceso"
          value={formatPercent(variants.conformantPct)}
          hint="Sin pasos fuera de orden ni ajenos al proceso"
          tone={conformanceTone(variants.conformantPct)}
        />
        <StatCard
          label="Con retrabajo"
          value={formatPercent(variants.reworkPct)}
          hint="Repitieron al menos un paso"
          tone={variants.reworkPct > 20 ? 'warning' : 'default'}
        />
        <StatCard
          label="Caminos distintos"
          value={formatCount(variants.variants.length)}
          hint="Cuantos más caminos, menos estándar es el proceso"
        />
      </KpiGrid>

      <section className="neural-panel" aria-labelledby="neural-variants-title">
        <div className="neural-panel-head">
          <h2 className="neural-panel-title" id="neural-variants-title">
            <GitBranch className="h-4 w-4" aria-hidden="true" /> Caminos recorridos
          </h2>
          {selectedVariant ? (
            <button
              type="button"
              className="neural-row-button"
              onClick={() => setVariantHash(null)}
            >
              Quitar el resaltado
            </button>
          ) : null}
        </div>

        {variants.variants.length === 0 ? (
          <EmptyState
            icon="layers"
            title="Todavía no hay variantes en este periodo"
            message="Las variantes se calculan con los pasos completados de cada expediente. Cuando el primer expediente avance —y corra la proyección de variantes— aparecerán aquí."
          />
        ) : (
          <div className="neural-table-wrap">
            <table className="neural-table">
              <caption className="sr-only">
                Caminos distintos recorridos por los expedientes del periodo
              </caption>
              <thead>
                <tr>
                  <th scope="col">Camino</th>
                  <th scope="col" className="neural-table-num">
                    Expedientes
                  </th>
                  <th scope="col" className="neural-table-num">
                    Del total
                  </th>
                  <th scope="col" className="neural-table-num">
                    Duración p50
                  </th>
                  <th scope="col" className="neural-table-num">
                    Duración p90
                  </th>
                  <th scope="col" className="neural-table-num">
                    Conformidad
                  </th>
                </tr>
              </thead>
              <tbody>
                {variants.variants.map((variant) => (
                  <tr
                    key={variant.variantHash}
                    className={
                      variant.variantHash === variantHash ? 'neural-table-row-active' : undefined
                    }
                  >
                    <th scope="row">
                      <button
                        type="button"
                        className="neural-row-button"
                        aria-pressed={variant.variantHash === variantHash}
                        onClick={() =>
                          setVariantHash((current) =>
                            current === variant.variantHash ? null : variant.variantHash
                          )
                        }
                      >
                        {variant.label}
                      </button>
                    </th>
                    <td className="neural-table-num">{formatCount(variant.cases)}</td>
                    <td className="neural-table-num">{formatPercent(variant.sharePct)}</td>
                    <td className="neural-table-num">{formatMinutes(variant.p50DurationMin)}</td>
                    <td className="neural-table-num">{formatMinutes(variant.p90DurationMin)}</td>
                    <td className="neural-table-num">{formatPercent(variant.conformancePct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="neural-panel" aria-labelledby="neural-variants-process">
        <div className="neural-panel-head">
          <h2 className="neural-panel-title" id="neural-variants-process">
            El camino sobre el proceso
          </h2>
        </div>
        <ProcessViewer
          versions={versions}
          selectedVersionId={selectedVersionId}
          view={processView}
          cycle={cycle}
          range={range}
          rangePreset={rangePreset}
          variantLabel={selectedVariant ? selectedVariant.label : null}
          embedded
          selectedStepKey={stepKey}
          onSelectStep={setStepKey}
        />
      </section>

      <section className="neural-panel" aria-labelledby="neural-bottlenecks">
        <div className="neural-panel-head">
          <h2 className="neural-panel-title" id="neural-bottlenecks">
            Dónde se detiene el trabajo
          </h2>
          <p className="neural-panel-hint">
            Ordenado por la espera que acumula en TODOS los expedientes, no por el paso más lento.
          </p>
        </div>
        <BottleneckRanking
          rows={stepMetrics.bottlenecks}
          activeStepKey={stepKey}
          onSelectStep={setStepKey}
        />
      </section>

      <section className="neural-panel" aria-labelledby="neural-handoffs">
        <div className="neural-panel-head">
          <h2 className="neural-panel-title" id="neural-handoffs">
            Traspasos entre áreas
          </h2>
        </div>
        <HandoffMatrix view={handoffs} />
      </section>

      <section className="neural-panel" aria-labelledby="neural-causes">
        <div className="neural-panel-head">
          <h2 className="neural-panel-title" id="neural-causes">
            Qué bloquea
          </h2>
        </div>
        <CauseTable
          view={causes}
          causeType={causeType}
          onFilterType={(next) => go({ causa: next })}
        />
      </section>

      <section className="neural-panel" aria-labelledby="neural-rework">
        <div className="neural-panel-head">
          <h2 className="neural-panel-title" id="neural-rework">
            Expedientes que se salieron del proceso
          </h2>
        </div>
        <ReworkList cases={variants.nonConformant} truncated={variants.truncated} />
      </section>
    </div>
  );
}
