import Link from 'next/link';
import type { BudgetVsActualResult } from '@/modules/finance/cashflow-service';
import {
  CONTABILIDAD_BASE_PATH,
  budgetTone,
  budgetUsedPercent,
  formatMoney,
  formatPercent,
  formatPeriodKey,
} from '@/modules/areas/contabilidad/contabilidad-model';

export interface BudgetVsActualCardProps {
  periodKey: string;
  comparison: BudgetVsActualResult | null;
  /** Rows shown before "ver todo" (the whole table lives in Presupuestos). */
  limit?: number;
  /** Hides the link when the card is already inside Presupuestos. */
  showManageLink?: boolean;
}

const TONE_CLASS = {
  default: '',
  success: '',
  warning: 'fin-aging-warning',
  danger: 'fin-aging-danger',
  info: '',
  weak: '',
} as const;

/**
 * Presupuesto contra real por categoría (plan 7.6). Muestra lo que se lleva
 * gastado del periodo y qué categorías ya se pasaron, sin inventar un
 * presupuesto donde no lo hay.
 */
export function BudgetVsActualCard({
  periodKey,
  comparison,
  limit = 6,
  showManageLink = true,
}: BudgetVsActualCardProps) {
  const totalPercent = comparison
    ? budgetUsedPercent(comparison.totals.actual, comparison.totals.budget)
    : null;
  const rows = (comparison?.rows ?? [])
    .slice()
    .sort((a, b) => Math.abs(Number(b.actual)) - Math.abs(Number(a.actual)))
    .slice(0, limit);

  return (
    <section className="fin-card" aria-labelledby="fin-budget-title">
      <div className="fin-card-head">
        <h3 className="fin-card-title" id="fin-budget-title">
          Presupuesto contra real
        </h3>
        <span className="fin-card-hint">{formatPeriodKey(periodKey)}</span>
      </div>

      {!comparison || comparison.rows.length === 0 ? (
        <div className="fin-empty">
          <strong>Sin presupuesto ni gasto en este periodo</strong>
          <p>
            Captura el presupuesto por centro y categoría para comparar contra lo que realmente se
            gastó.
          </p>
          {showManageLink ? (
            <p>
              <Link
                className="fin-section-link"
                href={`${CONTABILIDAD_BASE_PATH}/presupuestos?periodo=${periodKey}`}
              >
                Capturar presupuesto
              </Link>
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <p className="fin-card-hint">
            {formatMoney(comparison.totals.actual)} de {formatMoney(comparison.totals.budget)}{' '}
            presupuestado · consumido {formatPercent(totalPercent)}
          </p>

          <div className="fin-table-wrap">
            <table className="fin-table">
              <caption className="sr-only">
                Presupuesto contra real por categoría en {formatPeriodKey(periodKey)}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Categoría</th>
                  <th scope="col">Centro</th>
                  <th scope="col" className="fin-num">
                    Presupuesto
                  </th>
                  <th scope="col" className="fin-num">
                    Real
                  </th>
                  <th scope="col" className="fin-num">
                    Consumido
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const tone = budgetTone(row.usedPct);
                  return (
                    <tr key={`${row.costCenterId}-${row.categoryId}`}>
                      <td>{row.categoryName}</td>
                      <td className="fin-muted">{row.costCenterName}</td>
                      <td className="fin-num">
                        {row.budgeted ? (
                          formatMoney(row.budget)
                        ) : (
                          <span className="fin-muted">—</span>
                        )}
                      </td>
                      <td className="fin-num">{formatMoney(row.actual)}</td>
                      <td className={`fin-num ${TONE_CLASS[tone]}`.trim()}>
                        {row.usedPct === null ? (
                          <span className="fin-muted">Sin presupuesto</span>
                        ) : (
                          formatPercent(row.usedPct)
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <ul className="fin-cards">
            {rows.map((row) => (
              <li key={`${row.costCenterId}-${row.categoryId}`} className="fin-row-card">
                <span className="fin-row-card-head">
                  <span className="fin-row-card-title">{row.categoryName}</span>
                  <span className="fin-num">{formatMoney(row.actual)}</span>
                </span>
                <span className="fin-muted">
                  {row.costCenterName} ·{' '}
                  {row.budgeted
                    ? `${formatMoney(row.budget)} presupuestado · ${formatPercent(row.usedPct)}`
                    : 'Sin presupuesto'}
                </span>
              </li>
            ))}
          </ul>

          {showManageLink ? (
            <div className="fin-actions">
              <Link
                className="fin-section-link"
                href={`${CONTABILIDAD_BASE_PATH}/presupuestos?periodo=${periodKey}`}
              >
                Ver y capturar presupuestos
              </Link>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
