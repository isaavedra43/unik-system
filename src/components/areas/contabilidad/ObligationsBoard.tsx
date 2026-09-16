'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banknote, CalendarClock, ShieldCheck } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  FormField,
  Input,
  Select,
  Textarea,
} from '@/components/ui/primitives';
import type {
  CollectionsView,
  ObligationRowView,
  ObligationsView,
} from '@/modules/areas/contabilidad/queries';
import {
  AGING_BUCKETS_UI,
  CONTABILIDAD_BASE_PATH,
  agingBucketLabel,
  agingBucketTone,
  canSettleNow,
  formatDateKey,
  formatMoney,
  obligationStatusLabel,
  obligationStatusTone,
  paymentAuthorizationLabel,
  paymentAuthorizationTone,
} from '@/modules/areas/contabilidad/contabilidad-model';
import {
  allocationIssues,
  matchPaymentCommand,
  recordUnexpectedCollectionCommand,
  requestPaymentAuthorizationCommand,
  rescheduleIssues,
  rescheduleObligationCommand,
  settleObligationCommand,
  settlementIssues,
  writeOffObligationCommand,
} from './contabilidad-ui-model';
import { useFinanceCommand } from './use-finance-command';

/**
 * Obligaciones por pagar y por cobrar (plan 6.4 / 7.6): la antigüedad por
 * bucket, la liquidación con su evidencia, la autorización de pago y los cobros
 * de Zoho que todavía nadie asignó.
 *
 * Las reglas son del motor: una cuenta por pagar sin autorización no se liquida
 * (el botón lo dice en lugar de fallar), el importe nunca pasa del pendiente y
 * cada acción viaja como comando con la versión de la obligación.
 */

const BADGE_BY_TONE = {
  default: 'default',
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  info: 'info',
  weak: 'weak',
} as const;

const TONE_CLASS = {
  default: '',
  success: '',
  info: '',
  weak: '',
  warning: 'fin-aging-warning',
  danger: 'fin-aging-danger',
} as const;

export interface ObligationsBoardProps {
  user: { id: string; name: string };
  view: ObligationsView;
  collections: CollectionsView;
  focusObligationId: string | null;
}

type PendingDialog =
  | { kind: 'settle'; row: ObligationRowView }
  | { kind: 'write_off'; row: ObligationRowView }
  | { kind: 'reschedule'; row: ObligationRowView }
  | { kind: 'assign'; paymentId: string };

export function ObligationsBoard({
  user,
  view,
  collections,
  focusObligationId,
}: ObligationsBoardProps) {
  const router = useRouter();
  const { run, busy, online } = useFinanceCommand(user.id);
  const [pending, setPending] = useState<PendingDialog | null>(null);
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [memo, setMemo] = useState('');
  const [reason, setReason] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [attachEvidence, setAttachEvidence] = useState(true);
  const [allocation, setAllocation] = useState<{ obligationId: string; amount: string }>({
    obligationId: '',
    amount: '',
  });
  const [issues, setIssues] = useState<string[]>([]);

  const focus = useMemo(
    () =>
      focusObligationId ? (view.rows.find((row) => row.id === focusObligationId) ?? null) : null,
    [focusObligationId, view.rows]
  );

  function navigate(patch: Record<string, string | null>) {
    const params = new URLSearchParams();
    const current: Record<string, string | null> = {
      tipo: view.filters.kind,
      estado: view.filters.status === 'open' ? null : view.filters.status,
      bucket: view.filters.agingBucket,
      vencidas: view.filters.overdueOnly ? '1' : null,
      buscar: view.filters.search,
      ...patch,
    };
    for (const [key, value] of Object.entries(current)) {
      if (value) params.set(key, value);
    }
    const query = params.toString();
    router.push(`${CONTABILIDAD_BASE_PATH}/obligaciones${query ? `?${query}` : ''}`);
  }

  function openSettle(row: ObligationRowView) {
    setPending({ kind: 'settle', row });
    setAmount(row.remaining);
    setAccountId(view.accounts[0]?.id ?? '');
    setMemo('');
    setAttachEvidence(row.suggestedEvidenceObjectIds.length > 0);
    setIssues([]);
  }

  async function confirmSettle() {
    if (pending?.kind !== 'settle') return;
    const row = pending.row;
    const account = view.accounts.find((candidate) => candidate.id === accountId) ?? null;
    const found = settlementIssues({
      amount,
      remaining: row.remaining,
      cashAccountId: accountId || null,
      currency: row.currency,
      accountCurrency: account?.currency ?? null,
      canSettle: canSettleNow(row),
    });
    if (found.length > 0) {
      setIssues(found);
      return;
    }
    const result = await run(
      settleObligationCommand({
        obligationId: row.id,
        version: row.version,
        amount,
        cashAccountId: accountId,
        memo: memo || null,
        ...(attachEvidence && row.suggestedEvidenceObjectIds.length > 0
          ? { evidenceObjectIds: row.suggestedEvidenceObjectIds }
          : {}),
      }),
      row.kind === 'payable' ? 'Pago registrado' : 'Cobro registrado'
    );
    if (result.ok) {
      setPending(null);
      router.refresh();
    }
  }

  async function confirmWriteOff() {
    if (pending?.kind !== 'write_off') return;
    if (reason.trim().length < 5) {
      setIssues(['Escribe el motivo del castigo (mínimo 5 caracteres)']);
      return;
    }
    const result = await run(
      writeOffObligationCommand(pending.row.id, pending.row.version, reason),
      `${pending.row.number} castigada`
    );
    if (result.ok) {
      setPending(null);
      setReason('');
      router.refresh();
    }
  }

  /**
   * Renegocia la fecha con el proveedor o corrige la que se capturó mal. No
   * toca el asiento ni el importe: antes había que cancelar la obligación (lo
   * que reversa su asiento) y volver a crearla, o dejarla vencida en falso.
   */
  async function confirmReschedule() {
    if (pending?.kind !== 'reschedule') return;
    const row = pending.row;
    const found = rescheduleIssues({ dueAt, currentDueAt: row.dueAt, reason });
    if (found.length > 0) {
      setIssues(found);
      return;
    }
    const result = await run(
      rescheduleObligationCommand({
        obligationId: row.id,
        version: row.version,
        dueAt,
        reason,
      }),
      `${row.number} reprogramada`
    );
    if (result.ok) {
      setPending(null);
      setReason('');
      setDueAt('');
      router.refresh();
    }
  }

  async function requestAuthorization(row: ObligationRowView) {
    const result = await run(
      requestPaymentAuthorizationCommand(row.id),
      'Autorización de pago solicitada'
    );
    if (result.ok) router.refresh();
  }

  async function confirmAssign() {
    if (pending?.kind !== 'assign') return;
    const payment = collections.payments.find((item) => item.zohoPaymentId === pending.paymentId);
    if (!payment) return;
    const allocations = allocation.obligationId
      ? [{ obligationId: allocation.obligationId, amount: allocation.amount || payment.remaining }]
      : [];
    const found = allocationIssues(payment.remaining, allocations);
    if (found.length > 0) {
      setIssues(found);
      return;
    }
    const result = await run(
      matchPaymentCommand(payment.zohoPaymentId, allocations),
      'Cobro asignado'
    );
    if (result.ok) {
      setPending(null);
      setAllocation({ obligationId: '', amount: '' });
      router.refresh();
    }
  }

  async function recordUnexpected(paymentId: string, categoryId: string) {
    const result = await run(
      recordUnexpectedCollectionCommand({ zohoPaymentId: paymentId, categoryId }),
      'Ingreso registrado'
    );
    if (result.ok) router.refresh();
  }

  const kinds: Array<{ id: string; label: string; value: string | null }> = [
    { id: 'all', label: 'Todas', value: null },
    { id: 'payable', label: 'Por pagar', value: 'payable' },
    { id: 'receivable', label: 'Por cobrar', value: 'receivable' },
  ];

  return (
    <div className="fin-page">
      {!online ? (
        <Alert variant="info">
          Sin conexión: los pagos y cobros que registres se enviarán al volver.
        </Alert>
      ) : null}

      {focus ? (
        <Alert variant="info">
          Mostrando {focus.number} · {focus.counterpartyName ?? focus.description} ·{' '}
          {formatMoney(focus.remaining, focus.currency)} pendiente.
        </Alert>
      ) : null}

      <section className="fin-card" aria-labelledby="fin-aging-title">
        <div className="fin-card-head">
          <h2 className="fin-card-title" id="fin-aging-title">
            Antigüedad
          </h2>
          <span className="fin-card-hint">Saldo pendiente por vencimiento</span>
        </div>
        {(['payable', 'receivable'] as const).map((kind) => (
          <div key={kind} className="fin-section">
            <h3 className="fin-card-hint">{kind === 'payable' ? 'Por pagar' : 'Por cobrar'}</h3>
            <div className="fin-aging">
              {AGING_BUCKETS_UI.map((bucket) => {
                const tone = agingBucketTone(bucket);
                return (
                  <button
                    key={`${kind}-${bucket}`}
                    type="button"
                    className={`fin-aging-bucket ${TONE_CLASS[tone]}`.trim()}
                    onClick={() => navigate({ tipo: kind, bucket, vencidas: null })}
                  >
                    <span className="fin-aging-label">{agingBucketLabel(bucket)}</span>
                    <span className="fin-aging-value">{formatMoney(view.aging[kind][bucket])}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      <div className="fin-toolbar">
        <div className="fin-toolbar-field">
          <label htmlFor="fin-kind">Tipo</label>
          <Select
            id="fin-kind"
            value={view.filters.kind ?? 'all'}
            onChange={(event) =>
              navigate({ tipo: event.target.value === 'all' ? null : event.target.value })
            }
          >
            {kinds.map((option) => (
              <option key={option.id} value={option.value ?? 'all'}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="fin-toolbar-field">
          <label htmlFor="fin-status">Estado</label>
          <Select
            id="fin-status"
            value={view.filters.status}
            onChange={(event) => navigate({ estado: event.target.value })}
          >
            <option value="open">Abiertas</option>
            <option value="settled">Liquidadas</option>
            <option value="written_off">Castigadas</option>
            <option value="cancelled">Canceladas</option>
            <option value="all">Todas</option>
          </Select>
        </div>
        <div className="fin-toolbar-field">
          <label htmlFor="fin-search">Buscar</label>
          <Input
            id="fin-search"
            defaultValue={view.filters.search ?? ''}
            placeholder="Folio, contraparte o concepto"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                navigate({ buscar: (event.target as HTMLInputElement).value || null });
              }
            }}
          />
        </div>
        <Button
          variant={view.filters.overdueOnly ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => navigate({ vencidas: view.filters.overdueOnly ? null : '1' })}
        >
          Sólo vencidas
        </Button>
        {view.filters.agingBucket ? (
          <Button variant="ghost" size="sm" onClick={() => navigate({ bucket: null })}>
            Quitar filtro de antigüedad
          </Button>
        ) : null}
      </div>

      {view.rows.length === 0 ? (
        <div className="fin-empty">
          <strong>Sin obligaciones con estos filtros</strong>
          <p>Cambia el tipo, el estado o la antigüedad para ver otras cuentas.</p>
        </div>
      ) : (
        <>
          <div className="fin-table-wrap">
            <table className="fin-table">
              <caption className="sr-only">Obligaciones por pagar y por cobrar</caption>
              <thead>
                <tr>
                  <th scope="col">Folio</th>
                  <th scope="col">Contraparte</th>
                  <th scope="col">Vence</th>
                  <th scope="col">Antigüedad</th>
                  <th scope="col" className="fin-num">
                    Pendiente
                  </th>
                  <th scope="col">Estado</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => {
                  const settleable = canSettleNow(row);
                  const needsAuthorization =
                    row.kind === 'payable' &&
                    (row.paymentAuthorization === 'missing' ||
                      row.paymentAuthorization === 'rejected');
                  return (
                    <tr key={row.id}>
                      <td>
                        <span className="fin-row-card-title">{row.number}</span>
                        <div className="fin-muted">{row.description}</div>
                      </td>
                      <td>
                        {row.counterpartyName ?? '—'}
                        {row.expenseNumber ? (
                          <div className="fin-muted">Gasto {row.expenseNumber}</div>
                        ) : null}
                      </td>
                      <td>
                        {row.dueAt ? (
                          formatDateKey(row.dueAt)
                        ) : (
                          <span className="fin-muted">Sin fecha</span>
                        )}
                        {row.daysOverdue && row.daysOverdue > 0 ? (
                          <div className="fin-negative">Vencida hace {row.daysOverdue} días</div>
                        ) : null}
                      </td>
                      <td>{agingBucketLabel(row.agingBucket)}</td>
                      <td className="fin-num">{formatMoney(row.remaining, row.currency)}</td>
                      <td>
                        <Badge variant={BADGE_BY_TONE[obligationStatusTone(row.status)]}>
                          {obligationStatusLabel(row.status)}
                        </Badge>
                        {row.kind === 'payable' ? (
                          <div>
                            <Badge
                              variant={
                                BADGE_BY_TONE[paymentAuthorizationTone(row.paymentAuthorization)]
                              }
                            >
                              {paymentAuthorizationLabel(row.paymentAuthorization)}
                            </Badge>
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div className="fin-actions">
                          {view.capabilities.manageObligations && settleable ? (
                            <Button
                              variant="primary"
                              size="sm"
                              disabled={busy}
                              onClick={() => openSettle(row)}
                            >
                              <Banknote size={14} aria-hidden="true" />
                              {row.kind === 'payable' ? 'Pagar' : 'Cobrar'}
                            </Button>
                          ) : null}
                          {view.capabilities.manageObligations && needsAuthorization ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy}
                              onClick={() => requestAuthorization(row)}
                            >
                              <ShieldCheck size={14} aria-hidden="true" />
                              Pedir autorización
                            </Button>
                          ) : null}
                          {view.capabilities.manageObligations &&
                          (row.status === 'expected' || row.status === 'partially_settled') ? (
                            <>
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={busy}
                                onClick={() => {
                                  setPending({ kind: 'reschedule', row });
                                  setDueAt(row.dueAt ?? '');
                                  setReason('');
                                  setIssues([]);
                                }}
                              >
                                <CalendarClock size={14} aria-hidden="true" />
                                Reprogramar
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={busy}
                                onClick={() => {
                                  setPending({ kind: 'write_off', row });
                                  setReason('');
                                  setIssues([]);
                                }}
                              >
                                Castigar
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <ul className="fin-cards" aria-label="Obligaciones">
            {view.rows.map((row) => (
              <li key={`card-${row.id}`} className="fin-row-card">
                <span className="fin-row-card-head">
                  <span className="fin-row-card-title">
                    {row.number} · {row.counterpartyName ?? row.description}
                  </span>
                  <span className="fin-num">{formatMoney(row.remaining, row.currency)}</span>
                </span>
                <span className="fin-muted">
                  {row.kind === 'payable' ? 'Por pagar' : 'Por cobrar'} ·{' '}
                  {row.dueAt ? formatDateKey(row.dueAt) : 'sin fecha'} ·{' '}
                  {obligationStatusLabel(row.status)}
                </span>
                {view.capabilities.manageObligations && canSettleNow(row) ? (
                  <span>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      onClick={() => openSettle(row)}
                    >
                      {row.kind === 'payable' ? 'Pagar' : 'Cobrar'}
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>

          {view.pageCount > 1 ? (
            <div className="fin-pager">
              <span>
                Página {view.page} de {view.pageCount} · {view.total} obligaciones
              </span>
            </div>
          ) : null}
        </>
      )}

      <section className="fin-card" aria-labelledby="fin-collections-title">
        <div className="fin-card-head">
          <h2 className="fin-card-title" id="fin-collections-title">
            Cobros sin asignar
          </h2>
          <span className="fin-card-hint">
            Pagos de Zoho que no encontraron su cuenta por cobrar
          </span>
        </div>

        {collections.payments.length === 0 ? (
          <div className="fin-empty">
            <strong>Todo el dinero está asignado</strong>
            <p>Cuando llegue un pago que no case con una cuenta esperada, aparecerá aquí.</p>
          </div>
        ) : (
          <ul className="fin-cards" style={{ display: 'grid' }}>
            {collections.payments.map((payment) => (
              <li key={payment.zohoPaymentId} className="fin-row-card">
                <span className="fin-row-card-head">
                  <span className="fin-row-card-title">
                    {payment.paymentNumber ?? payment.zohoPaymentId} ·{' '}
                    {payment.customerName ?? 'Cliente sin nombre'}
                  </span>
                  <span className="fin-num">
                    {formatMoney(payment.remaining, payment.currency)}
                  </span>
                </span>
                <span className="fin-muted">
                  {payment.date ? formatDateKey(payment.date) : 'sin fecha'} · de{' '}
                  {formatMoney(payment.amount, payment.currency)} ·{' '}
                  {payment.referenceNumber ?? 'sin referencia'}
                </span>
                {collections.capabilities.manageObligations ? (
                  <span className="fin-actions">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setPending({ kind: 'assign', paymentId: payment.zohoPaymentId });
                        setAllocation({ obligationId: '', amount: payment.remaining });
                        setIssues([]);
                      }}
                    >
                      Asignar a una cuenta
                    </Button>
                    {collections.incomeCategories.length > 0 ? (
                      <Select
                        aria-label={`Registrar ${payment.paymentNumber ?? payment.zohoPaymentId} como ingreso`}
                        defaultValue=""
                        disabled={busy}
                        onChange={(event) => {
                          if (event.target.value) {
                            void recordUnexpected(payment.zohoPaymentId, event.target.value);
                          }
                        }}
                      >
                        <option value="">Registrar como ingreso…</option>
                        {collections.incomeCategories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                      </Select>
                    ) : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {pending?.kind === 'settle' ? (
        <Dialog open onOpenChange={(open) => (!open && !busy ? setPending(null) : undefined)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {pending.row.kind === 'payable' ? 'Registrar el pago' : 'Registrar el cobro'} de{' '}
                {pending.row.number}
              </DialogTitle>
              <DialogDescription>
                {pending.row.counterpartyName ?? pending.row.description} ·{' '}
                {formatMoney(pending.row.remaining, pending.row.currency)} pendiente
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <FormField label="Importe" htmlFor="fin-settle-amount">
                <Input
                  id="fin-settle-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  autoFocus
                />
              </FormField>
              <FormField label="Cuenta" htmlFor="fin-settle-account">
                <Select
                  id="fin-settle-account"
                  value={accountId}
                  onChange={(event) => setAccountId(event.target.value)}
                >
                  <option value="">Elige la cuenta</option>
                  {view.accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} ({account.currency})
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField
                label="Referencia"
                htmlFor="fin-settle-memo"
                help="Opcional: folio de la transferencia o del recibo."
              >
                <Input
                  id="fin-settle-memo"
                  maxLength={500}
                  value={memo}
                  onChange={(event) => setMemo(event.target.value)}
                />
              </FormField>
              {pending.row.suggestedEvidenceObjectIds.length > 0 ? (
                <Checkbox
                  label={`Adjuntar el comprobante del gasto ${pending.row.expenseNumber ?? ''}`.trim()}
                  description="Queda como evidencia de esta liquidación."
                  checked={attachEvidence}
                  onChange={(event) => setAttachEvidence(event.target.checked)}
                />
              ) : null}
              {issues.length > 0 ? (
                <Alert variant="error">
                  <ul>
                    {issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setPending(null)}
              >
                Cancelar
              </Button>
              <Button variant="primary" size="sm" disabled={busy} onClick={confirmSettle}>
                {busy ? 'Enviando…' : 'Registrar'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {pending?.kind === 'write_off' ? (
        <Dialog open onOpenChange={(open) => (!open && !busy ? setPending(null) : undefined)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Castigar {pending.row.number}</DialogTitle>
              <DialogDescription>
                El saldo pendiente se reconoce como incobrable o como otro ingreso, con su asiento.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <FormField label="Motivo" htmlFor="fin-writeoff-reason" help="Mínimo 5 caracteres.">
                <Textarea
                  id="fin-writeoff-reason"
                  rows={3}
                  maxLength={500}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  autoFocus
                />
              </FormField>
              {issues.length > 0 ? <Alert variant="error">{issues[0]}</Alert> : null}
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setPending(null)}
              >
                Cancelar
              </Button>
              <Button variant="danger" size="sm" disabled={busy} onClick={confirmWriteOff}>
                {busy ? 'Enviando…' : 'Castigar'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {pending?.kind === 'reschedule' ? (
        <Dialog open onOpenChange={(open) => (!open && !busy ? setPending(null) : undefined)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Reprogramar {pending.row.number}</DialogTitle>
              <DialogDescription>
                Cambia la fecha de vencimiento que se renegoció con la contraparte o que se capturó
                mal. No se toca el importe ni el asiento.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <FormField
                label="Nueva fecha de vencimiento"
                htmlFor="fin-reschedule-due"
                help={
                  pending.row.dueAt
                    ? `Hoy vence el ${formatDateKey(pending.row.dueAt)}.`
                    : 'La obligación no tenía fecha de vencimiento.'
                }
              >
                <Input
                  id="fin-reschedule-due"
                  type="date"
                  value={dueAt}
                  onChange={(event) => setDueAt(event.target.value)}
                  autoFocus
                />
              </FormField>
              <FormField label="Motivo" htmlFor="fin-reschedule-reason" help="Mínimo 3 caracteres.">
                <Textarea
                  id="fin-reschedule-reason"
                  rows={3}
                  maxLength={500}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </FormField>
              {issues.length > 0 ? <Alert variant="error">{issues[0]}</Alert> : null}
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setPending(null)}
              >
                Cancelar
              </Button>
              <Button variant="primary" size="sm" disabled={busy} onClick={confirmReschedule}>
                {busy ? 'Enviando…' : 'Reprogramar'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {pending?.kind === 'assign' ? (
        <Dialog open onOpenChange={(open) => (!open && !busy ? setPending(null) : undefined)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Asignar el cobro</DialogTitle>
              <DialogDescription>
                Elige la cuenta por cobrar a la que corresponde este pago.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <FormField label="Cuenta por cobrar" htmlFor="fin-assign-obligation">
                <Select
                  id="fin-assign-obligation"
                  value={allocation.obligationId}
                  onChange={(event) =>
                    setAllocation({ ...allocation, obligationId: event.target.value })
                  }
                >
                  <option value="">Elige la cuenta</option>
                  {collections.receivables.map((receivable) => (
                    <option key={receivable.id} value={receivable.id}>
                      {receivable.number} · {receivable.counterpartyName ?? receivable.description}{' '}
                      · {formatMoney(receivable.remaining, receivable.currency)}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="Importe a aplicar" htmlFor="fin-assign-amount">
                <Input
                  id="fin-assign-amount"
                  inputMode="decimal"
                  value={allocation.amount}
                  onChange={(event) => setAllocation({ ...allocation, amount: event.target.value })}
                />
              </FormField>
              {issues.length > 0 ? <Alert variant="error">{issues[0]}</Alert> : null}
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setPending(null)}
              >
                Cancelar
              </Button>
              <Button variant="primary" size="sm" disabled={busy} onClick={confirmAssign}>
                {busy ? 'Enviando…' : 'Asignar'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
