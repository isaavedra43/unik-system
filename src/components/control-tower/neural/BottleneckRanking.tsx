import type { BottleneckRow } from '@/modules/control-tower/variants';
import {
  areaLabel,
  barWidth,
  breachTone,
  formatCount,
  formatMinutes,
  formatPercent,
} from './neural-model';

export interface BottleneckRankingProps {
  rows: readonly BottleneckRow[];
  /** Paso resaltado en el visor (se marca la fila). */
  activeStepKey?: string | null;
  onSelectStep?: (stepKey: string | null) => void;
}

/**
 * Cuellos de botella (plan 7.8b/7.9): el paso que acumula MÁS ESPERA TOTAL
 * (`p90 de espera × iniciados`), no el que tarda más una vez. Un paso lentísimo
 * que ocurre dos veces al mes no es el problema; uno de media hora que ocurre
 * en cada expediente, sí.
 */
export function BottleneckRanking({
  rows,
  activeStepKey = null,
  onSelectStep,
}: BottleneckRankingProps) {
  if (rows.length === 0) {
    return (
      <p className="neural-panel-hint">
        Sin pasos medidos en el periodo: cuando los expedientes empiecen a cerrar pasos, aquí saldrá
        dónde se detiene el trabajo.
      </p>
    );
  }
  const max = Math.max(...rows.map((row) => row.impactMin));
  return (
    <div className="neural-table-wrap">
      <table className="neural-table">
        <caption className="sr-only">
          Pasos ordenados por la espera total que explican en el periodo
        </caption>
        <thead>
          <tr>
            <th scope="col">Paso</th>
            <th scope="col">Área</th>
            <th scope="col">Espera acumulada</th>
            <th scope="col" className="neural-table-num">
              p90 espera
            </th>
            <th scope="col" className="neural-table-num">
              Iniciados
            </th>
            <th scope="col" className="neural-table-num">
              Incumple
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.stepKey}
              className={row.stepKey === activeStepKey ? 'neural-table-row-active' : undefined}
            >
              <th scope="row">
                {onSelectStep ? (
                  <button
                    type="button"
                    className="neural-row-button"
                    aria-pressed={row.stepKey === activeStepKey}
                    onClick={() => onSelectStep(row.stepKey === activeStepKey ? null : row.stepKey)}
                  >
                    {row.label}
                  </button>
                ) : (
                  row.label
                )}
              </th>
              <td>{areaLabel(row.areaKey)}</td>
              <td>
                <span
                  className={`neural-bar neural-bar-${breachTone(row.breachPct) === 'danger' ? 'danger' : 'warning'}`}
                  role="img"
                  aria-label={`${formatMinutes(row.impactMin)} de espera acumulada`}
                >
                  <span
                    className="neural-bar-fill"
                    style={{ width: `${barWidth(row.impactMin, max)}%` }}
                  />
                </span>
                <span className="neural-badge-label"> {formatMinutes(row.impactMin)}</span>
              </td>
              <td className="neural-table-num">{formatMinutes(row.p90WaitMin)}</td>
              <td className="neural-table-num">{formatCount(row.started)}</td>
              <td className="neural-table-num">{formatPercent(row.breachPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
