'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Badge, Button, FormField, Input, Select } from '@/components/ui/primitives';
import type { PayrollView } from '@/modules/areas/contabilidad/queries';
import {
  CONTABILIDAD_BASE_PATH,
  formatDateKey,
  formatMoney,
  formatPeriodKey,
  payrollStatusLabel,
} from '@/modules/areas/contabilidad/contabilidad-model';
import {
  cancelPayrollRunCommand,
  closePayrollRunCommand,
  createPayrollObligationsCommand,
  createPayrollRunCommand,
  nextPayrollStep,
  payPayrollLineCommand,
  submitPayrollRunCommand,
} from './contabilidad-ui-model';
import { useFinanceCommand } from './use-finance-command';

/**
 * Nómina (plan 6.4): las corridas con su siguiente paso y las líneas por
 * empleado con su pago.
 *
 * El camino es el del módulo: se crea la corrida, se envía a aprobación, se
 * generan las cuentas por pagar (una por empleado), se pagan las líneas y se
 * cierra. Cada paso es un comando con la versión de la corrida.
 */

const BADGE_BY_STATUS: Readonly<
  Record<string, 'default' | 'success' | 'danger' | 'warning' | 'info' | 'weak'>
> = {
  draft: 'default',
  pending_approval: 'warning',
  approved: 'info',
  obligations_created: 'info',
  paid: 'success',
  closed: 'success',
  cancelled: 'weak',
};

export interface PayrollPanelProps {
  user: { id: string; name: string };
  view: PayrollView;
}

export function PayrollPanel({ user, view }: PayrollPanelProps) {
  const router = useRouter();
  const { run, busy, online } = useFinanceCommand(user.id);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [gross, setGross] = useState<Record<string, string>>({});
  const [payAccount, setPayAccount] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run_ = view.run;
  const step = run_ ? nextPayrollStep(run_.status) : null;
  const employeeName = (id: string) =>
    view.employees.find((employee) => employee.id === id)?.name ??
    run_?.employees.find((employee) => employee.id === id)?.name ??
    id;

  async function createRun() {
    const lines = Object.entries(gross)
      .filter(([, value]) => Number(value) > 0)
      .map(([employeeId, value]) => ({ employeeId, gross: value }));
    if (!periodStart || !periodEnd) {
      setError('Indica el periodo de la corrida');
      return;
    }
    if (lines.length === 0) {
      setError('Captura el sueldo de al menos un empleado');
      return;
    }
    setError(null);
    const result = await run<{ payrollRunId?: string }>(
      createPayrollRunCommand({ periodStart, periodEnd, lines }),
      'Corrida de nómina creada'
    );
    if (result.ok && result.data?.payrollRunId) {
      router.push(`${CONTABILIDAD_BASE_PATH}/nomina?corrida=${result.data.payrollRunId}`);
    }
  }

  async function advance() {
    if (!run_ || !step) return;
    if (step.key === 'submit') {
      const result = await run(
        submitPayrollRunCommand(run_.id, run_.version),
        'Nómina enviada a aprobación'
      );
      if (result.ok) router.refresh();
      return;
    }
    if (step.key === 'obligations') {
      const result = await run(
        createPayrollObligationsCommand(run_.id, run_.version),
        'Cuentas por pagar creadas'
      );
      if (result.ok) router.refresh();
      return;
    }
    if (step.key === 'close') {
      const result = await run(closePayrollRunCommand(run_.id, run_.version), 'Corrida cerrada');
      if (result.ok) router.refresh();
    }
  }

  async function payLine(employeeId: string) {
    if (!run_) return;
    if (!payAccount) {
      setError('Elige la cuenta de donde sale el pago');
      return;
    }
    setError(null);
    const result = await run(
      payPayrollLineCommand(run_.id, run_.version, { employeeId, cashAccountId: payAccount }),
      `Pago de ${employeeName(employeeId)} registrado`
    );
    if (result.ok) router.refresh();
  }

  async function cancelRun() {
    if (!run_) return;
    const reason = window.prompt('¿Por qué se cancela la corrida?')?.trim() ?? '';
    if (reason.length < 3) return;
    const result = await run(
      cancelPayrollRunCommand(run_.id, run_.version, reason),
      'Corrida cancelada'
    );
    if (result.ok) router.push(`${CONTABILIDAD_BASE_PATH}/nomina`);
  }

  return (
    <div className="fin-page">
      {!online ? (
        <Alert variant="info">Sin conexión: los pasos de la nómina se enviarán al volver.</Alert>
      ) : null}
      {error ? <Alert variant="error">{error}</Alert> : null}

      <section className="fin-card" aria-labelledby="fin-runs-title">
        <div className="fin-card-head">
          <h2 className="fin-card-title" id="fin-runs-title">
            Corridas de nómina
          </h2>
          <span className="fin-card-hint">{view.runs.length} recientes</span>
        </div>

        {view.runs.length === 0 ? (
          <div className="fin-empty">
            <strong>Todavía no hay corridas</strong>
            <p>Crea la primera con el periodo y el sueldo de cada empleado.</p>
          </div>
        ) : (
          <ul className="fin-cards" style={{ display: 'grid' }}>
            {view.runs.map((item) => (
              <li key={item.id} className="fin-row-card">
                <span className="fin-row-card-head">
                  <a
                    className="fin-row-card-title"
                    href={`${CONTABILIDAD_BASE_PATH}/nomina?corrida=${item.id}`}
                  >
                    {item.number} · {formatPeriodKey(item.periodKey)}
                  </a>
                  <span className="fin-num">{formatMoney(item.totalNet, item.currency)}</span>
                </span>
                <span className="fin-muted">
                  {formatDateKey(item.periodStart)} a {formatDateKey(item.periodEnd)} ·{' '}
                  <Badge variant={BADGE_BY_STATUS[item.status] ?? 'default'}>
                    {payrollStatusLabel(item.status)}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {run_ ? (
        <section className="fin-card" aria-labelledby="fin-run-title">
          <div className="fin-card-head">
            <h2 className="fin-card-title" id="fin-run-title">
              {run_.number} · {formatPeriodKey(run_.periodKey)}
            </h2>
            <Badge variant={BADGE_BY_STATUS[run_.status] ?? 'default'}>
              {payrollStatusLabel(run_.status)}
            </Badge>
          </div>

          <p className="fin-card-hint">
            Bruto {formatMoney(run_.totalGross, run_.currency)} · deducciones{' '}
            {formatMoney(run_.totalDeductions, run_.currency)} · neto{' '}
            {formatMoney(run_.totalNet, run_.currency)}
          </p>

          {step && view.capabilities.payroll ? (
            <div className="fin-next">
              <span className="fin-next-text">
                <span className="fin-next-label">{step.label}</span>
                <span className="fin-next-detail">{step.detail}</span>
              </span>
              {step.key === 'submit' || step.key === 'obligations' || step.key === 'close' ? (
                <Button variant="primary" size="sm" disabled={busy} onClick={advance}>
                  {busy ? 'Enviando…' : step.label}
                </Button>
              ) : null}
            </div>
          ) : null}

          {run_.status === 'obligations_created' && view.capabilities.payroll ? (
            <FormField label="Cuenta de pago" htmlFor="fin-pay-account">
              <Select
                id="fin-pay-account"
                value={payAccount}
                onChange={(event) => setPayAccount(event.target.value)}
              >
                <option value="">Elige la cuenta</option>
                {view.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}

          <div className="fin-table-wrap">
            <table className="fin-table">
              <caption className="sr-only">Líneas de la corrida {run_.number}</caption>
              <thead>
                <tr>
                  <th scope="col">Empleado</th>
                  <th scope="col" className="fin-num">
                    Bruto
                  </th>
                  <th scope="col" className="fin-num">
                    Deducciones
                  </th>
                  <th scope="col" className="fin-num">
                    Anticipos
                  </th>
                  <th scope="col" className="fin-num">
                    Neto
                  </th>
                  <th scope="col">Estado</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {(run_.lines ?? []).map((line) => {
                  const deductions = line.deductions.reduce(
                    (sum, deduction) => sum + Number(deduction.amount),
                    0
                  );
                  return (
                    <tr key={line.id}>
                      <td>{employeeName(line.employeeId)}</td>
                      <td className="fin-num">{formatMoney(line.gross, run_.currency)}</td>
                      <td className="fin-num">{formatMoney(deductions, run_.currency)}</td>
                      <td className="fin-num">
                        {formatMoney(line.advancesApplied, run_.currency)}
                      </td>
                      <td className="fin-num">{formatMoney(line.net, run_.currency)}</td>
                      <td>
                        <Badge variant={line.status === 'paid' ? 'success' : 'warning'}>
                          {line.status === 'paid' ? 'Pagada' : 'Por pagar'}
                        </Badge>
                      </td>
                      <td>
                        {line.status !== 'paid' &&
                        run_.status === 'obligations_created' &&
                        view.capabilities.payroll ? (
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={busy}
                            onClick={() => payLine(line.employeeId)}
                          >
                            Pagar
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <ul className="fin-cards">
            {(run_.lines ?? []).map((line) => (
              <li key={`card-${line.id}`} className="fin-row-card">
                <span className="fin-row-card-head">
                  <span className="fin-row-card-title">{employeeName(line.employeeId)}</span>
                  <span className="fin-num">{formatMoney(line.net, run_.currency)}</span>
                </span>
                <span className="fin-muted">
                  Bruto {formatMoney(line.gross, run_.currency)} ·{' '}
                  {line.status === 'paid' ? 'pagada' : 'por pagar'}
                </span>
                {line.status !== 'paid' &&
                run_.status === 'obligations_created' &&
                view.capabilities.payroll ? (
                  <span>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      onClick={() => payLine(line.employeeId)}
                    >
                      Pagar
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>

          {view.capabilities.payroll && run_.status !== 'closed' && run_.status !== 'cancelled' ? (
            <div className="fin-actions">
              <Button variant="secondary" size="sm" disabled={busy} onClick={cancelRun}>
                Cancelar corrida
              </Button>
            </div>
          ) : null}
        </section>
      ) : view.capabilities.payroll ? (
        <section className="fin-card" aria-labelledby="fin-new-run-title">
          <h2 className="fin-card-title" id="fin-new-run-title">
            Nueva corrida
          </h2>
          <div className="fin-fields">
            <FormField label="Del" htmlFor="fin-run-start">
              <Input
                id="fin-run-start"
                type="date"
                value={periodStart}
                onChange={(event) => setPeriodStart(event.target.value)}
              />
            </FormField>
            <FormField label="Al" htmlFor="fin-run-end">
              <Input
                id="fin-run-end"
                type="date"
                value={periodEnd}
                onChange={(event) => setPeriodEnd(event.target.value)}
              />
            </FormField>
          </div>

          {view.employees.length === 0 ? (
            <div className="fin-empty">
              <strong>Sin empleados activos</strong>
              <p>Da de alta el directorio en Catálogos para poder correr la nómina.</p>
            </div>
          ) : (
            <div className="fin-fields">
              {view.employees.map((employee) => (
                <FormField
                  key={employee.id}
                  label={`${employee.name}${employee.position ? ` · ${employee.position}` : ''}`}
                  htmlFor={`fin-gross-${employee.id}`}
                  help="Sueldo bruto del periodo; déjalo vacío para excluirlo."
                >
                  <Input
                    id={`fin-gross-${employee.id}`}
                    inputMode="decimal"
                    value={gross[employee.id] ?? ''}
                    onChange={(event) => setGross({ ...gross, [employee.id]: event.target.value })}
                  />
                </FormField>
              ))}
            </div>
          )}

          <div className="fin-actions">
            <Button variant="primary" size="sm" disabled={busy} onClick={createRun}>
              {busy ? 'Creando…' : 'Crear corrida'}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
