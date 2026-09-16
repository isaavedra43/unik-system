// `.case-progress*` / `.case-phase*` viven en esta hoja: sin importarla aquí la story
// sale sin estilo.
import '@/styles/operations/case-360.css';
import type { CaseProgress } from './case-model';

export interface CasePhaseProgressProps {
  progress: CaseProgress;
  /** Label of the phase the case is in right now. */
  currentPhaseLabel: string;
}

/**
 * Progress of a case over the steps of its process: one bar, the count of
 * steps and the phases of the blueprint. Presentational and server-safe (no
 * hooks): the numbers come from `caseProgress`.
 */
export function CasePhaseProgress({ progress, currentPhaseLabel }: CasePhaseProgressProps) {
  const label =
    progress.total === 0
      ? 'Todavía no hay pasos instanciados'
      : `${progress.done} de ${progress.total} pasos`;

  return (
    <div className="case-progress">
      <div className="case-progress-head">
        <strong>
          Fase: {currentPhaseLabel} · {label}
        </strong>
        <span>
          {progress.percent}%
          {progress.overdue > 0
            ? ` · ${progress.overdue} ${progress.overdue === 1 ? 'paso vencido' : 'pasos vencidos'}`
            : ''}
        </span>
      </div>

      <div
        className="case-progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-label={`Avance del proceso: ${label}`}
      >
        <div className="case-progress-fill" style={{ width: `${progress.percent}%` }} />
      </div>

      {progress.phases.length > 0 ? (
        <ul className="case-phases">
          {progress.phases.map((phase) => (
            <li
              key={phase.key}
              className={`case-phase ${
                phase.state === 'done'
                  ? 'case-phase-done'
                  : phase.state === 'current'
                    ? 'case-phase-current'
                    : ''
              }`.trim()}
            >
              <span className="case-phase-dot" aria-hidden="true" />
              <span>
                {phase.label}
                {phase.total > 0 ? ` ${phase.done}/${phase.total}` : ''}
              </span>
              <span className="sr-only">
                {phase.state === 'done'
                  ? ' (terminada)'
                  : phase.state === 'current'
                    ? ' (fase actual)'
                    : ' (pendiente)'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
