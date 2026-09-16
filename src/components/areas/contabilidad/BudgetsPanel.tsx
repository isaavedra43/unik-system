'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, FormField, Input, Select } from '@/components/ui/primitives';
import type { BudgetsView } from '@/modules/areas/contabilidad/queries';
import {
  CONTABILIDAD_BASE_PATH,
  formatMoney,
  formatPeriodKey,
} from '@/modules/areas/contabilidad/contabilidad-model';
import { BudgetVsActualCard } from './BudgetVsActualCard';
import { setBudgetCommand } from './contabilidad-ui-model';
import { useFinanceCommand } from './use-finance-command';

/**
 * Presupuesto por periodo, centro y categoría (plan 6.4). Capturar un
 * presupuesto es el comando `finance.budget.set`, que sustituye el importe del
 * mismo trío (periodo, centro, categoría) en vez de duplicarlo.
 *
 * Un centro o una categoría vacíos significan "todos": así se presupuesta el
 * mes completo sin desglosar y se compara igual contra el real.
 */

export interface BudgetsPanelProps {
  user: { id: string; name: string };
  view: BudgetsView;
}

export function BudgetsPanel({ user, view }: BudgetsPanelProps) {
  const router = useRouter();
  const { run, busy, online } = useFinanceCommand(user.id);
  const [categoryId, setCategoryId] = useState('');
  const [costCenterId, setCostCenterId] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  const nameOfCategory = (id: string) =>
    id
      ? (view.categories.find((category) => category.id === id)?.name ?? id)
      : 'Todas las categorías';
  const nameOfCenter = (id: string) =>
    id ? (view.costCenters.find((center) => center.id === id)?.name ?? id) : 'Todos los centros';

  async function save(input: { categoryId: string; costCenterId: string; amount: string }) {
    if (!(Number(input.amount) >= 0) || input.amount.trim() === '') {
      setError('Escribe un importe válido');
      return;
    }
    setError(null);
    const result = await run(
      setBudgetCommand({
        periodKey: view.periodKey,
        categoryId: input.categoryId,
        costCenterId: input.costCenterId,
        amount: input.amount,
      }),
      'Presupuesto guardado'
    );
    if (result.ok) {
      setAmount('');
      router.refresh();
    }
  }

  return (
    <div className="fin-page">
      {!online ? (
        <Alert variant="info">Sin conexión: los cambios se enviarán al volver.</Alert>
      ) : null}

      <div className="fin-toolbar">
        <div className="fin-toolbar-field">
          <label htmlFor="fin-period">Periodo</label>
          <Input
            id="fin-period"
            type="month"
            value={view.periodKey}
            onChange={(event) =>
              router.push(`${CONTABILIDAD_BASE_PATH}/presupuestos?periodo=${event.target.value}`)
            }
          />
        </div>
      </div>

      <BudgetVsActualCard
        periodKey={view.periodKey}
        comparison={view.comparison}
        limit={40}
        showManageLink={false}
      />

      <section className="fin-card" aria-labelledby="fin-budgets-title">
        <div className="fin-card-head">
          <h2 className="fin-card-title" id="fin-budgets-title">
            Presupuesto de {formatPeriodKey(view.periodKey)}
          </h2>
          <span className="fin-card-hint">
            {view.budgets.length} {view.budgets.length === 1 ? 'renglón' : 'renglones'}
          </span>
        </div>

        {view.capabilities.manageCatalog ? (
          <div className="fin-fields">
            <FormField label="Categoría" htmlFor="fin-budget-category">
              <Select
                id="fin-budget-category"
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
              >
                <option value="">Todas las categorías</option>
                {view.categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Centro de costo" htmlFor="fin-budget-center">
              <Select
                id="fin-budget-center"
                value={costCenterId}
                onChange={(event) => setCostCenterId(event.target.value)}
              >
                <option value="">Todos los centros</option>
                {view.costCenters.map((center) => (
                  <option key={center.id} value={center.id}>
                    {center.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Importe" htmlFor="fin-budget-amount">
              <Input
                id="fin-budget-amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </FormField>
            <div className="fin-field-wide fin-actions">
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => save({ categoryId, costCenterId, amount })}
              >
                {busy ? 'Guardando…' : 'Guardar presupuesto'}
              </Button>
              {error ? <Alert variant="error">{error}</Alert> : null}
            </div>
          </div>
        ) : (
          <p className="fin-card-hint">
            Puedes consultar el presupuesto; capturarlo necesita el permiso de catálogo.
          </p>
        )}

        {view.budgets.length === 0 ? (
          <div className="fin-empty">
            <strong>Sin presupuesto capturado</strong>
            <p>
              Empieza con un importe para todo el mes y desglósalo por categoría cuando quieras.
            </p>
          </div>
        ) : (
          <>
            <div className="fin-table-wrap">
              <table className="fin-table">
                <caption className="sr-only">
                  Presupuesto capturado de {formatPeriodKey(view.periodKey)}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Categoría</th>
                    <th scope="col">Centro</th>
                    <th scope="col" className="fin-num">
                      Importe
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.budgets.map((budget) => (
                    <tr key={budget.id}>
                      <td>{nameOfCategory(budget.categoryId)}</td>
                      <td className="fin-muted">{nameOfCenter(budget.costCenterId)}</td>
                      <td className="fin-num">{formatMoney(budget.amount, budget.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="fin-cards">
              {view.budgets.map((budget) => (
                <li key={`card-${budget.id}`} className="fin-row-card">
                  <span className="fin-row-card-head">
                    <span className="fin-row-card-title">{nameOfCategory(budget.categoryId)}</span>
                    <span className="fin-num">{formatMoney(budget.amount, budget.currency)}</span>
                  </span>
                  <span className="fin-muted">{nameOfCenter(budget.costCenterId)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
