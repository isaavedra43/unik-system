'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Unlock } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { Alert, Button, FormField, Input, Textarea } from '@/components/ui/primitives';
import type { CloseView } from '@/modules/areas/contabilidad/queries';
import {
  countDifference,
  formatDateKey,
  formatMoney,
  formatPeriodKey,
} from '@/modules/areas/contabilidad/contabilidad-model';
import { CloseChecklistCard } from './CloseChecklistCard';
import {
  cashCounts,
  countTone,
  dailyCloseCommand,
  monthlyCloseCommand,
  reopenPeriodCommand,
  reopenReasonIssue,
} from './contabilidad-ui-model';
import { useFinanceCommand } from './use-finance-command';

/**
 * Cierre del periodo (plan 6.4 / 7.6): el arqueo de las cajas, el checklist con
 * sus bloqueos y la reapertura con motivo.
 *
 * El cierre no lo decide esta pantalla: se manda el comando y el motor evalúa
 * sus reglas (gastos pendientes, cobros sin asignar, arqueo y cuadre del
 * libro). Si algo bloquea, el periodo sigue abierto y el checklist lo explica.
 */

const TONE_CLASS = {
  default: '',
  success: '',
  info: '',
  weak: '',
  warning: 'fin-aging-warning',
  danger: 'fin-aging-danger',
} as const;

export interface ClosePanelProps {
  user: { id: string; name: string };
  view: CloseView;
}

export function ClosePanel({ user, view }: ClosePanelProps) {
  const router = useRouter();
  const { run, busy, online } = useFinanceCommand(user.id);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [reopen, setReopen] = useState<{ kind: 'daily' | 'monthly'; periodKey: string } | null>(
    null
  );
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  const countedAccounts = view.accounts.filter((account) => account.needsCount);

  async function runDaily() {
    const result = await run(
      dailyCloseCommand(view.dailyTargetKey, cashCounts(counts)),
      `Cierre del ${formatDateKey(view.dailyTargetKey)} ejecutado`
    );
    if (result.ok) router.refresh();
  }

  async function runMonthly() {
    const result = await run(
      monthlyCloseCommand(view.monthlyTargetKey, cashCounts(counts)),
      `Cierre de ${formatPeriodKey(view.monthlyTargetKey)} ejecutado`
    );
    if (result.ok) router.refresh();
  }

  async function confirmReopen() {
    if (!reopen) return;
    const issue = reopenReasonIssue(reason);
    if (issue) {
      setReasonError(issue);
      return;
    }
    const result = await run(
      reopenPeriodCommand(reopen.kind, reopen.periodKey, reason),
      'Periodo reabierto'
    );
    if (result.ok) {
      setReopen(null);
      setReason('');
      setReasonError(null);
      router.refresh();
    }
  }

  return (
    <div className="fin-page">
      {!online ? (
        <Alert variant="info">
          Sin conexión: el cierre se enviará cuando vuelvas a estar en línea.
        </Alert>
      ) : null}

      {!view.capabilities.close ? (
        <Alert variant="info">
          Puedes consultar el avance del cierre; ejecutarlo o reabrirlo necesita el permiso de
          cierres.
        </Alert>
      ) : null}

      <section className="fin-card" aria-labelledby="fin-count-title">
        <div className="fin-card-head">
          <h2 className="fin-card-title" id="fin-count-title">
            Arqueo de cajas
          </h2>
          <span className="fin-card-hint">
            Saldo del libro al {formatDateKey(view.dailyTargetKey)}
          </span>
        </div>

        {countedAccounts.length === 0 ? (
          <p className="fin-card-hint">
            No hay cajas ni cajas chicas activas: el cierre diario no pide arqueo.
          </p>
        ) : (
          <div className="fin-fields">
            {countedAccounts.map((account) => {
              const counted = counts[account.id] ?? '';
              const difference = countDifference(account.balanceAtCutoff, counted);
              const tone = counted ? countTone(account.balanceAtCutoff, counted) : 'default';
              return (
                <FormField
                  key={account.id}
                  label={`${account.name} · libro ${formatMoney(account.balanceAtCutoff, account.currency)}`}
                  htmlFor={`fin-count-${account.id}`}
                  help={
                    difference === null
                      ? 'Escribe lo que contaste físicamente.'
                      : difference === 0
                        ? 'Cuadra con el libro.'
                        : `Diferencia de ${formatMoney(difference, account.currency)}.`
                  }
                >
                  <Input
                    id={`fin-count-${account.id}`}
                    inputMode="decimal"
                    className={TONE_CLASS[tone]}
                    value={counted}
                    disabled={!view.capabilities.close}
                    onChange={(event) => setCounts({ ...counts, [account.id]: event.target.value })}
                  />
                </FormField>
              );
            })}
          </div>
        )}
      </section>

      <div className="fin-columns-even fin-columns">
        <CloseChecklistCard
          kind="daily"
          periodKey={view.dailyTargetKey}
          status={view.daily?.status ?? null}
          checks={view.daily?.checks ?? []}
          actions={
            view.capabilities.close ? (
              <>
                {view.daily?.status !== 'closed' ? (
                  <Button variant="primary" size="sm" disabled={busy} onClick={runDaily}>
                    <Lock size={14} aria-hidden="true" />
                    {busy ? 'Ejecutando…' : `Cerrar el ${formatDateKey(view.dailyTargetKey)}`}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => setReopen({ kind: 'daily', periodKey: view.dailyTargetKey })}
                  >
                    <Unlock size={14} aria-hidden="true" />
                    Reabrir el día
                  </Button>
                )}
              </>
            ) : null
          }
        />

        <CloseChecklistCard
          kind="monthly"
          periodKey={view.monthlyTargetKey}
          status={view.monthly?.status ?? null}
          checks={view.monthly?.checks ?? []}
          actions={
            view.capabilities.close ? (
              <>
                {view.monthly?.status !== 'closed' ? (
                  <Button variant="primary" size="sm" disabled={busy} onClick={runMonthly}>
                    <Lock size={14} aria-hidden="true" />
                    {busy ? 'Ejecutando…' : `Cerrar ${formatPeriodKey(view.monthlyTargetKey)}`}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => setReopen({ kind: 'monthly', periodKey: view.monthlyTargetKey })}
                  >
                    <Unlock size={14} aria-hidden="true" />
                    Reabrir el mes
                  </Button>
                )}
              </>
            ) : null
          }
        />
      </div>

      {view.history.length > 0 ? (
        <section className="fin-card" aria-labelledby="fin-history-title">
          <h2 className="fin-card-title" id="fin-history-title">
            Cierres recientes
          </h2>
          <div className="fin-table-wrap">
            <table className="fin-table">
              <caption className="sr-only">Historial de cierres diarios y mensuales</caption>
              <thead>
                <tr>
                  <th scope="col">Periodo</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Bloqueos</th>
                  <th scope="col">Motivo de reapertura</th>
                </tr>
              </thead>
              <tbody>
                {view.history.map((close) => (
                  <tr key={close.id}>
                    <td>
                      {close.kind === 'monthly'
                        ? formatPeriodKey(close.periodKey)
                        : formatDateKey(close.periodKey)}
                    </td>
                    <td>{close.kind === 'monthly' ? 'Mensual' : 'Diario'}</td>
                    <td>{close.status}</td>
                    <td>
                      {close.checks.filter((check) => !check.ok && check.blocking).length || '—'}
                    </td>
                    <td className="fin-muted">{close.reopenReason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="fin-cards">
            {view.history.map((close) => (
              <li key={`card-${close.id}`} className="fin-row-card">
                <span className="fin-row-card-head">
                  <span className="fin-row-card-title">
                    {close.kind === 'monthly'
                      ? formatPeriodKey(close.periodKey)
                      : formatDateKey(close.periodKey)}
                  </span>
                  <span className="fin-muted">{close.status}</span>
                </span>
                <span className="fin-muted">
                  {close.checks.filter((check) => !check.ok && check.blocking).length} bloqueos
                  {close.reopenReason ? ` · reabierto: ${close.reopenReason}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {reopen ? (
        <Dialog open onOpenChange={(open) => (!open && !busy ? setReopen(null) : undefined)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>
                Reabrir el cierre{' '}
                {reopen.kind === 'monthly'
                  ? formatPeriodKey(reopen.periodKey)
                  : formatDateKey(reopen.periodKey)}
              </DialogTitle>
              <DialogDescription>
                Queda registrado quién lo reabrió y por qué; el libro vuelve a aceptar asientos de
                ese periodo.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <FormField
                label="Motivo"
                htmlFor="fin-reopen-reason"
                help="Al menos 10 caracteres: es la justificación de auditoría."
              >
                <Textarea
                  id="fin-reopen-reason"
                  rows={3}
                  maxLength={1000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  autoFocus
                />
              </FormField>
              {reasonError ? <Alert variant="error">{reasonError}</Alert> : null}
            </div>
            <DialogFooter>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setReopen(null)}>
                Cancelar
              </Button>
              <Button variant="danger" size="sm" disabled={busy} onClick={confirmReopen}>
                {busy ? 'Enviando…' : 'Reabrir'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
