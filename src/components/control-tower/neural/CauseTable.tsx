import type { CausesView } from '@/modules/control-tower/projections-service';
import { barWidth, formatCount, formatMinutes } from './neural-model';

export interface CauseTableProps {
  view: CausesView;
  /** Tipo de causa filtrado (`null` = todas). */
  causeType: string | null;
  onFilterType?: (causeType: string | null) => void;
}

/**
 * Causas de bloqueo (plan 7.8b `CauseTable`): qué proveedor, producto, ruta,
 * cliente o motivo de espera acumula más minutos detenidos.
 *
 * Se ordena por MINUTOS ACUMULADOS, no por número de bloqueos: cinco bloqueos
 * de diez minutos no son el problema; uno de tres días, sí.
 */
export function CauseTable({ view, causeType, onFilterType }: CauseTableProps) {
  if (view.causes.length === 0) {
    return (
      <p className="neural-panel-hint">
        Sin causas de bloqueo registradas en el periodo. Se alimentan de las incidencias y de los
        motivos de espera de los pasos.
      </p>
    );
  }
  const max = Math.max(...view.causes.map((cause) => cause.waitMin));

  return (
    <>
      {onFilterType && view.byType.length > 1 ? (
        <div className="neural-chip-row" aria-label="Filtrar por tipo de causa">
          <button
            type="button"
            className="neural-chip"
            aria-pressed={causeType === null}
            onClick={() => onFilterType(null)}
          >
            Todas
          </button>
          {view.byType.map((entry) => (
            <button
              key={entry.causeType}
              type="button"
              className="neural-chip"
              aria-pressed={causeType === entry.causeType}
              onClick={() => onFilterType(entry.causeType)}
            >
              {entry.label} · {formatMinutes(entry.waitMin)}
            </button>
          ))}
        </div>
      ) : null}

      <div className="neural-table-wrap">
        <table className="neural-table">
          <caption className="sr-only">
            Causas de bloqueo ordenadas por los minutos de espera que acumulan
          </caption>
          <thead>
            <tr>
              <th scope="col">Causa</th>
              <th scope="col">Tipo</th>
              <th scope="col">Espera acumulada</th>
              <th scope="col" className="neural-table-num">
                Bloqueos
              </th>
              <th scope="col" className="neural-table-num">
                Promedio
              </th>
            </tr>
          </thead>
          <tbody>
            {view.causes.map((cause) => (
              <tr key={`${cause.causeType}:${cause.causeKey}`}>
                <th scope="row">{cause.causeLabel}</th>
                <td>{cause.causeTypeLabel}</td>
                <td>
                  <span
                    className="neural-bar neural-bar-danger"
                    role="img"
                    aria-label={`${formatMinutes(cause.waitMin)} de espera acumulada`}
                  >
                    <span
                      className="neural-bar-fill"
                      style={{ width: `${barWidth(cause.waitMin, max)}%` }}
                    />
                  </span>
                  <span className="neural-badge-label"> {formatMinutes(cause.waitMin)}</span>
                </td>
                <td className="neural-table-num">{formatCount(cause.blocks)}</td>
                <td className="neural-table-num">{formatMinutes(cause.avgWaitMin)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
