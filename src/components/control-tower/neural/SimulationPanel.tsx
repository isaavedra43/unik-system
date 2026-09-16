'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FlaskConical, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { KpiGrid } from '@/components/patterns/dashboard/KpiGrid';
import { StatCard } from '@/components/patterns/dashboard/StatCard';
import { Alert, Button, Input, Select } from '@/components/ui/primitives';
import type { ApplyToOpenCasesResult, CaseSimulation } from '@/modules/control-tower/simulation';
import { caseHref, formatDateTime, formatDay, formatMinutes, neuralHref } from './neural-model';
import {
  capacityError,
  capacityLabel,
  capacityOptions,
  criticalPathLabels,
  delayError,
  delayOptions,
  describeScenario,
  diffRows,
  emptyScenario,
  factorToPercent,
  percentToFactor,
  scenarioIsEmpty,
  simulationTiles,
  toScenarioPayload,
  type ScenarioDraft,
} from './simulation-model';

export interface SimulationCaseOption {
  id: string;
  caseNumber: string;
  customerName: string | null;
  promisedAt: string | null;
}

export interface SimulationPanelProps {
  /** Simulación inicial calculada en el servidor (sin escenario). */
  initial: CaseSimulation | null;
  caseId: string | null;
  cases: readonly SimulationCaseOption[];
  applyLimit: number;
  /** El servidor no pudo simular (por ejemplo, no hay blueprint publicado). */
  loadError: string | null;
}

/**
 * Panel de simulación (plan 7.8e): "¿qué pasa con la fecha prometida si este
 * paso se retrasa dos horas o si Compras rinde a la mitad?".
 *
 * El cálculo NO vive aquí: se manda a `/api/simulate`, que hace el pase hacia
 * adelante sobre las dependencias reales con las duraciones medidas (p50 activo
 * + p50 espera) y cae al SLA del paso cuando aún no hay historia. Nada se
 * escribe: simular es una lectura.
 */
export function SimulationPanel({
  initial,
  caseId,
  cases,
  applyLimit,
  loadError,
}: SimulationPanelProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [draft, setDraft] = useState<ScenarioDraft>(emptyScenario);
  const [result, setResult] = useState<CaseSimulation | null>(initial);
  const [applied, setApplied] = useState<ApplyToOpenCasesResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(loadError);

  const [delayStep, setDelayStep] = useState('');
  const [delayMinutes, setDelayMinutes] = useState('60');
  const [capacityArea, setCapacityArea] = useState('');
  const [capacityPercent, setCapacityPercent] = useState('50');
  const [formError, setFormError] = useState<string | null>(null);

  const base = result ?? initial;
  const steps = useMemo(() => delayOptions(base), [base]);
  const areas = useMemo(() => capacityOptions(base), [base]);
  const stepLabels = useMemo(
    () => new Map(steps.map((option) => [option.stepKey, option.label])),
    [steps]
  );
  const rows = useMemo(() => diffRows(result), [result]);
  const tiles = useMemo(
    () => simulationTiles(result, (value) => (value ? formatDateTime(value) : 'Sin fecha')),
    [result]
  );
  const criticalPath = criticalPathLabels(result);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/app/admin/control-tower/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        simulation?: CaseSimulation;
        apply?: ApplyToOpenCasesResult;
        error?: string;
      };
      if (!response.ok) {
        setError(payload.error ?? 'No pudimos simular el escenario');
        return null;
      }
      return payload;
    } catch {
      setError('No pudimos simular el escenario. Revisa tu conexión.');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const simulate = async () => {
    const payload = await post({
      ...(caseId ? { caseId } : {}),
      scenario: toScenarioPayload(draft),
    });
    if (payload?.simulation) {
      setResult(payload.simulation);
      setApplied(null);
    }
  };

  const applyToOpenCases = async () => {
    const payload = await post({ apply: true, scenario: toScenarioPayload(draft) });
    if (payload?.apply) setApplied(payload.apply);
  };

  const addDelay = () => {
    const minutes = Number(delayMinutes);
    const message = delayError(minutes);
    if (!delayStep) {
      setFormError('Elige el paso que se retrasa');
      return;
    }
    if (message) {
      setFormError(message);
      return;
    }
    setFormError(null);
    setDraft((current) => ({ ...current, delays: { ...current.delays, [delayStep]: minutes } }));
  };

  const addCapacity = () => {
    const factor = percentToFactor(Number(capacityPercent));
    const message = capacityError(factor);
    if (!capacityArea) {
      setFormError('Elige el área');
      return;
    }
    if (message) {
      setFormError(message);
      return;
    }
    if (factor === 1) {
      setFormError('Ese porcentaje no cambia nada: usa uno distinto de 100 %');
      return;
    }
    setFormError(null);
    setDraft((current) => ({
      ...current,
      capacity: { ...current.capacity, [capacityArea]: factor },
    }));
  };

  const removeDelay = (stepKey: string) => {
    setDraft((current) => {
      const delays = { ...current.delays };
      delete delays[stepKey];
      return { ...current, delays };
    });
  };

  const removeCapacity = (areaKey: string) => {
    setDraft((current) => {
      const capacity = { ...current.capacity };
      delete capacity[areaKey];
      return { ...current, capacity };
    });
  };

  const payload = toScenarioPayload(draft);

  return (
    <div className="neural-shell">
      <div className="neural-toolbar">
        <div className="neural-toolbar-field">
          <label htmlFor="neural-sim-case">Qué se simula</label>
          <Select
            id="neural-sim-case"
            value={caseId ?? ''}
            onChange={(event) =>
              startTransition(() =>
                router.push(neuralHref('simulacion', { caso: event.target.value || null }))
              )
            }
          >
            <option value="">Una venta nueva (el proceso completo)</option>
            {cases.map((option) => (
              <option key={option.id} value={option.id}>
                {option.caseNumber}
                {option.customerName ? ` · ${option.customerName}` : ''}
                {option.promisedAt ? ` · prometido ${formatDay(option.promisedAt)}` : ''}
              </option>
            ))}
          </Select>
        </div>
        <p className="neural-toolbar-note">
          Sin expediente se proyecta una venta que empezara hoy, con las duraciones medidas de cada
          paso. Con un expediente se respeta lo que ya ocurrió y sólo se proyecta lo que falta.
        </p>
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className="neural-sim-grid">
        <section className="neural-panel" aria-labelledby="neural-sim-form">
          <div className="neural-panel-head">
            <h2 className="neural-panel-title" id="neural-sim-form">
              <FlaskConical className="h-4 w-4" aria-hidden="true" /> Escenario
            </h2>
            {!scenarioIsEmpty(draft) ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setDraft(emptyScenario())}
                icon={<RotateCcw className="h-4 w-4" />}
              >
                Limpiar
              </Button>
            ) : null}
          </div>

          {formError ? <Alert variant="warning">{formError}</Alert> : null}

          <div className="neural-sim-form">
            <div className="neural-toolbar-field">
              <label htmlFor="neural-sim-step">Retrasar un paso</label>
              <Select
                id="neural-sim-step"
                value={delayStep}
                onChange={(event) => setDelayStep(event.target.value)}
                disabled={steps.length === 0}
              >
                <option value="">Elige el paso…</option>
                {steps.map((option) => (
                  <option key={option.stepKey} value={option.stepKey}>
                    {option.label} · {option.areaLabel}
                  </option>
                ))}
              </Select>
            </div>
            <div className="neural-sim-entry">
              <div className="neural-toolbar-field">
                <label htmlFor="neural-sim-minutes">Minutos extra</label>
                <Input
                  id="neural-sim-minutes"
                  type="number"
                  min={0}
                  max={43200}
                  step={15}
                  value={delayMinutes}
                  onChange={(event) => setDelayMinutes(event.target.value)}
                />
              </div>
              <Button
                type="button"
                variant="secondary"
                onClick={addDelay}
                disabled={steps.length === 0}
                icon={<Plus className="h-4 w-4" />}
              >
                Agregar
              </Button>
            </div>

            {payload.delays.length > 0 ? (
              <ul className="neural-sim-list" aria-label="Retrasos del escenario">
                {payload.delays.map((delay) => (
                  <li key={delay.stepKey} className="neural-sim-chip">
                    <span>
                      {stepLabels.get(delay.stepKey) ?? delay.stepKey} · +
                      {formatMinutes(delay.minutes)}
                    </span>
                    <button
                      type="button"
                      className="neural-row-button"
                      onClick={() => removeDelay(delay.stepKey)}
                      aria-label={`Quitar el retraso de ${stepLabels.get(delay.stepKey) ?? delay.stepKey}`}
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="neural-toolbar-field">
              <label htmlFor="neural-sim-area">Cambiar la capacidad de un área</label>
              <Select
                id="neural-sim-area"
                value={capacityArea}
                onChange={(event) => setCapacityArea(event.target.value)}
                disabled={areas.length === 0}
              >
                <option value="">Elige el área…</option>
                {areas.map((option) => (
                  <option key={option.areaKey} value={option.areaKey}>
                    {option.label} · {option.steps} pasos
                  </option>
                ))}
              </Select>
            </div>
            <div className="neural-sim-entry">
              <div className="neural-toolbar-field">
                <label htmlFor="neural-sim-capacity">Capacidad (% de hoy)</label>
                <Input
                  id="neural-sim-capacity"
                  type="number"
                  min={10}
                  max={1000}
                  step={10}
                  value={capacityPercent}
                  onChange={(event) => setCapacityPercent(event.target.value)}
                  aria-describedby="neural-sim-capacity-help"
                />
              </div>
              <Button
                type="button"
                variant="secondary"
                onClick={addCapacity}
                disabled={areas.length === 0}
                icon={<Plus className="h-4 w-4" />}
              >
                Agregar
              </Button>
              <p id="neural-sim-capacity-help" className="neural-panel-hint">
                100 % es como hoy. 50 % es la mitad del ritmo ({capacityLabel(0.5)}).
              </p>
            </div>

            {payload.capacity.length > 0 ? (
              <ul className="neural-sim-list" aria-label="Cambios de capacidad del escenario">
                {payload.capacity.map((entry) => (
                  <li key={entry.areaKey} className="neural-sim-chip">
                    <span>
                      {areas.find((area) => area.areaKey === entry.areaKey)?.label ?? entry.areaKey}{' '}
                      · {factorToPercent(entry.factor)} % ({capacityLabel(entry.factor)})
                    </span>
                    <button
                      type="button"
                      className="neural-row-button"
                      onClick={() => removeCapacity(entry.areaKey)}
                      aria-label={`Quitar el cambio de capacidad de ${entry.areaKey}`}
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <p className="neural-panel-hint">{describeScenario(draft, stepLabels)}</p>

            <div className="neural-toolbar-actions">
              <Button type="button" onClick={() => void simulate()} isLoading={busy}>
                Simular
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void applyToOpenCases()}
                disabled={busy || scenarioIsEmpty(draft)}
              >
                Aplicar a expedientes abiertos
              </Button>
            </div>
            <p className="neural-panel-hint">
              «Aplicar» no cambia nada: revisa hasta {applyLimit} expedientes abiertos con fecha
              prometida y lista los que la incumplirían con este escenario.
            </p>
          </div>
        </section>

        <section className="neural-panel" aria-labelledby="neural-sim-result">
          <div className="neural-panel-head">
            <h2 className="neural-panel-title" id="neural-sim-result">
              Resultado
            </h2>
            {result?.caseNumber ? (
              <p className="neural-panel-hint">Expediente {result.caseNumber}</p>
            ) : null}
          </div>

          {!result ? (
            <p className="neural-panel-hint">
              Todavía no hay nada que simular. Publica una versión del proceso o elige un expediente
              con pasos.
            </p>
          ) : (
            <>
              <KpiGrid columns={4}>
                {tiles.map((tile) => (
                  <StatCard
                    key={tile.key}
                    label={tile.label}
                    value={tile.value}
                    tone={tile.tone}
                    {...(tile.hint ? { hint: tile.hint } : {})}
                  />
                ))}
              </KpiGrid>

              {criticalPath.length > 0 ? (
                <p className="neural-sim-path">
                  <strong>Camino crítico:</strong>
                  {criticalPath.map((label, position) => (
                    <span key={`${label}-${position}`} className="neural-sequence-step">
                      {label}
                    </span>
                  ))}
                </p>
              ) : null}

              <div className="neural-table-wrap">
                <table className="neural-table">
                  <caption className="sr-only">
                    Diferencia por paso entre la proyección de hoy y la del escenario
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Paso</th>
                      <th scope="col">Área</th>
                      <th scope="col" className="neural-table-num">
                        Duración
                      </th>
                      <th scope="col" className="neural-table-num">
                        Termina
                      </th>
                      <th scope="col" className="neural-table-num">
                        Se recorre
                      </th>
                      <th scope="col" className="neural-table-num">
                        Holgura
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.ref}>
                        <th scope="row">
                          {row.label}
                          {row.critical ? (
                            <span className="neural-badge neural-badge-warning"> crítico</span>
                          ) : null}
                        </th>
                        <td>{row.areaLabel}</td>
                        <td className="neural-table-num">{formatMinutes(row.durationMin)}</td>
                        <td className="neural-table-num">{formatDateTime(row.scenarioFinish)}</td>
                        <td className="neural-table-num">{row.shiftLabel}</td>
                        <td className="neural-table-num">{row.slackLabel}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="neural-panel-hint">
                Los pasos sin historia usan su SLA como duración. Cuando la proyección de métricas
                corra con más datos, el resultado se afina solo.
              </p>
            </>
          )}
        </section>
      </div>

      {applied ? (
        <section className="neural-panel" aria-labelledby="neural-sim-apply">
          <div className="neural-panel-head">
            <h2 className="neural-panel-title" id="neural-sim-apply">
              Expedientes abiertos que incumplirían
            </h2>
            <p className="neural-panel-hint">
              {applied.evaluated} evaluados · {applied.breaching.length} incumplirían
              {applied.truncated ? ` · hay más de ${applyLimit} abiertos` : ''}
            </p>
          </div>
          {applied.breaching.length === 0 ? (
            <p className="neural-panel-hint">
              Ningún expediente abierto incumpliría su fecha prometida con este escenario.
            </p>
          ) : (
            <div className="neural-table-wrap">
              <table className="neural-table">
                <caption className="sr-only">
                  Expedientes abiertos que incumplirían su fecha prometida con el escenario
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Expediente</th>
                    <th scope="col">Cliente</th>
                    <th scope="col">Prometido</th>
                    <th scope="col">Terminaría</th>
                    <th scope="col" className="neural-table-num">
                      Se recorre
                    </th>
                    <th scope="col">Situación</th>
                  </tr>
                </thead>
                <tbody>
                  {applied.breaching.map((row) => (
                    <tr key={row.caseId}>
                      <th scope="row">
                        <Link className="neural-row-button" href={caseHref(row.caseId)}>
                          {row.caseNumber}
                        </Link>
                      </th>
                      <td>{row.customerName ?? '—'}</td>
                      <td>{formatDateTime(row.promisedAt)}</td>
                      <td>{formatDateTime(row.scenarioFinish)}</td>
                      <td className="neural-table-num">{formatMinutes(row.shiftMinutes)}</td>
                      <td>
                        {row.newlyLate ? (
                          <span className="neural-badge neural-badge-danger">
                            Lo rompe el escenario
                          </span>
                        ) : (
                          <span className="neural-badge neural-badge-warning">Ya venía tarde</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
