import type { HandoffsView } from '@/modules/control-tower/projections-service';
import { formatCount, formatMinutes } from './neural-model';

export interface HandoffMatrixProps {
  view: HandoffsView;
}

const KIND_LABELS: Record<HandoffsView['kind'], string> = {
  all: 'solicitudes entre áreas y reasignaciones de trabajo',
  request: 'solicitudes entre áreas',
  workitem: 'reasignaciones de trabajo',
};

/**
 * Matriz de traspasos área × área (plan 7.8b): cuántas veces un área le pasó
 * trabajo a otra, cuánto tardó la respuesta y cuántas se vencieron sin contestar.
 *
 * La fila es quien PIDE y la columna quien RESPONDE. La diagonal se marca pero
 * no se esconde: un área que se pasa trabajo a sí misma también es información.
 */
export function HandoffMatrix({ view }: HandoffMatrixProps) {
  if (view.areas.length === 0 || view.cells.length === 0) {
    return (
      <p className="neural-panel-hint">
        Sin traspasos registrados en el periodo ({KIND_LABELS[view.kind]}).
      </p>
    );
  }

  const byPair = new Map(view.cells.map((cell) => [`${cell.fromAreaKey}|${cell.toAreaKey}`, cell]));

  return (
    <div className="neural-table-wrap">
      <table className="neural-table neural-matrix">
        <caption className="sr-only">
          Traspasos del periodo: la fila pide y la columna responde ({KIND_LABELS[view.kind]})
        </caption>
        <thead>
          <tr>
            <th scope="col">De ↓ / A →</th>
            {view.areas.map((area) => (
              <th key={area.key} scope="col">
                {area.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.areas.map((from) => (
            <tr key={from.key}>
              <th scope="row">{from.label}</th>
              {view.areas.map((to) => {
                const cell = byPair.get(`${from.key}|${to.key}`);
                const diagonal = from.key === to.key;
                if (!cell) {
                  return (
                    <td
                      key={to.key}
                      className={`neural-matrix-cell neural-matrix-cell-empty${diagonal ? ' neural-matrix-diagonal' : ''}`}
                    >
                      —
                    </td>
                  );
                }
                return (
                  <td
                    key={to.key}
                    className={`neural-matrix-cell${diagonal ? ' neural-matrix-diagonal' : ''}`}
                  >
                    <strong>{formatCount(cell.count)}</strong>
                    <span className="neural-matrix-detail">
                      responde en {formatMinutes(cell.p50ResponseMin)}
                    </span>
                    {cell.expired > 0 ? (
                      <span className="neural-matrix-detail neural-matrix-cell-expired">
                        {formatCount(cell.expired)} sin contestar
                      </span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td colSpan={view.areas.length} className="neural-matrix-cell">
              {formatCount(view.total)} traspasos · {formatCount(view.expired)} vencidos sin
              respuesta
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
