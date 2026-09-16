import Link from 'next/link';
import { History } from 'lucide-react';
import type { VariantsView } from '@/modules/control-tower/projections-service';
import { caseHref, formatCount, neuralHref } from './neural-model';

export interface ReworkListProps {
  cases: VariantsView['nonConformant'];
  /** Se llegó al tope de expedientes leídos en el rango. */
  truncated?: boolean;
}

const KIND_LABELS: Record<string, string> = {
  unknown_step: 'Paso fuera del proceso',
  out_of_order: 'Fuera de orden',
  missing_final: 'Cerró sin terminar',
};

/**
 * Expedientes que se salieron del proceso o que repitieron pasos (plan 7.8b).
 *
 * Desviación y retrabajo son cosas distintas y por eso van en columnas
 * distintas: desviarse es hacer algo que el proceso no contempla; repetir un
 * paso es retrabajo, y puede ser perfectamente legítimo.
 */
export function ReworkList({ cases, truncated = false }: ReworkListProps) {
  if (cases.length === 0) {
    return (
      <p className="neural-panel-hint">
        Ningún expediente del periodo se salió del proceso. Si esperabas desviaciones, revisa que la
        proyección de variantes esté al día.
      </p>
    );
  }
  return (
    <>
      <div className="neural-table-wrap">
        <table className="neural-table">
          <caption className="sr-only">
            Expedientes con desviaciones del proceso o con pasos repetidos
          </caption>
          <thead>
            <tr>
              <th scope="col">Expediente</th>
              <th scope="col">Cliente</th>
              <th scope="col">Qué pasó</th>
              <th scope="col" className="neural-table-num">
                Repeticiones
              </th>
              <th scope="col">Abrir</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((row) => (
              <tr key={row.caseId}>
                <th scope="row">{row.caseNumber ?? row.caseId}</th>
                <td>{row.customerName ?? '—'}</td>
                <td>
                  <ul className="neural-sim-list">
                    {row.violations.slice(0, 3).map((violation, index) => (
                      <li key={`${violation.kind}-${violation.stepKey}-${index}`}>
                        <span className="neural-badge neural-badge-warning">
                          {KIND_LABELS[violation.kind] ?? violation.kind}
                        </span>{' '}
                        {violation.detail}
                      </li>
                    ))}
                    {row.violations.length > 3 ? (
                      <li className="neural-panel-hint">
                        y {row.violations.length - 3} desviaciones más
                      </li>
                    ) : null}
                    {row.violations.length === 0 ? (
                      <li className="neural-panel-hint">Siguió el proceso, pero repitió pasos</li>
                    ) : null}
                  </ul>
                </td>
                <td className="neural-table-num">{formatCount(row.reworkCount)}</td>
                <td>
                  <Link
                    className="neural-row-button"
                    href={neuralHref('replay', { caso: row.caseId })}
                  >
                    <History className="h-3 w-3" aria-hidden="true" /> Replay
                  </Link>{' '}
                  <Link className="neural-row-button" href={caseHref(row.caseId)}>
                    Expediente
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated ? (
        <p className="neural-panel-hint">
          El periodo tiene más expedientes de los que caben en una lectura: acorta el rango para ver
          el detalle completo.
        </p>
      ) : null}
    </>
  );
}
