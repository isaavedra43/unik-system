'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Camera, Keyboard, Mic, Paperclip, Send } from 'lucide-react';
import { toast } from 'sonner';
import { VoiceDictationButton } from '@/components/voice/VoiceDictationButton';
import {
  Alert,
  Badge,
  Button,
  FormField,
  Input,
  Select,
  Textarea,
} from '@/components/ui/primitives';
import { LoadingState } from '@/components/patterns/LoadingState';
import { uploadFile } from '@/lib/upload-client';
import type { ExpenseCaptureView } from '@/modules/areas/contabilidad/queries';
import {
  CONTABILIDAD_AREA_KEY,
  duplicateStatusLabel,
  expenseStatusLabel,
  expenseStatusTone,
  formatDateKey,
  formatMoney,
} from '@/modules/areas/contabilidad/contabilidad-model';
import { PAYMENT_METHODS } from '@/modules/finance/types';
import {
  captureExpenseCommand,
  nextExpenseStep,
  postExpenseCommand,
  proposalFields,
  proposalStatus,
  resolveExpenseDuplicateCommand,
  submitExpenseCommand,
  updateExpenseCommand,
  type ExpenseCaptureMode,
} from './contabilidad-ui-model';
import { useFinanceCommand } from './use-finance-command';

/**
 * Capturar un gasto con un solo botón (plan 6.4 / 7.6): se escribe, se dicta o
 * se toma la foto del ticket, la IA propone los campos, la persona los corrige
 * y el gasto se envía según la política de aprobación.
 *
 * Reglas que respeta tal cual: el comprobante se sube al destino
 * `expense_receipt` (el mismo que vuelve a revisar duplicados y encola la
 * propuesta), un duplicado sospechoso se resuelve ANTES de enviar, y cada
 * cambio viaja como comando (`finance.expense.*`) por la cola offline.
 */

const BADGE_BY_TONE = {
  default: 'default',
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  info: 'info',
  weak: 'weak',
} as const;

const MODES: Array<{ id: ExpenseCaptureMode; label: string; icon: typeof Keyboard; hint: string }> =
  [
    { id: 'text', label: 'Escribir', icon: Keyboard, hint: 'Descríbelo en una línea' },
    { id: 'voice', label: 'Dictar', icon: Mic, hint: 'Habla y lo transcribimos' },
    { id: 'photo', label: 'Foto', icon: Camera, hint: 'Toma el ticket o sube el PDF' },
  ];

const PROPOSAL_POLL_MS = 3000;
const PROPOSAL_POLL_MAX = 10;

export interface ExpenseQuickCaptureProps {
  user: { id: string; name: string };
  view: ExpenseCaptureView;
  /** Draft opened from a link (`?gasto=`): the form starts on it. */
  focusExpenseId: string | null;
  todayKey: string;
}

interface Fields {
  amount: string;
  date: string;
  supplierNameFree: string;
  categoryId: string;
  costCenterId: string;
  cashAccountId: string;
  paymentMethod: string;
  isPaid: boolean;
  description: string;
}

function fieldsOf(view: ExpenseCaptureView, todayKey: string): Fields {
  const expense = view.expense;
  return {
    amount: expense && Number(expense.amount) > 0 ? expense.amount : '',
    date: expense?.date ?? todayKey,
    supplierNameFree: expense?.supplierNameFree ?? '',
    categoryId: expense?.categoryId ?? '',
    costCenterId: expense?.costCenterId ?? '',
    cashAccountId: expense?.cashAccountId ?? '',
    paymentMethod: expense?.paymentMethod ?? '',
    isPaid: expense?.isPaid ?? true,
    description: expense?.description ?? '',
  };
}

export function ExpenseQuickCapture({
  user,
  view: initialView,
  focusExpenseId,
  todayKey,
}: ExpenseQuickCaptureProps) {
  const router = useRouter();
  const { run, busy, online } = useFinanceCommand(user.id);
  const fileRef = useRef<HTMLInputElement>(null);

  const [view, setView] = useState(initialView);
  const [mode, setMode] = useState<ExpenseCaptureMode>('text');
  const [rawInput, setRawInput] = useState('');
  const [fields, setFields] = useState<Fields>(() => fieldsOf(initialView, todayKey));
  const [uploading, setUploading] = useState(false);
  const [polls, setPolls] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const expense = view.expense;
  const expenseId = expense?.id ?? focusExpenseId ?? null;

  useEffect(() => {
    setView(initialView);
    setFields(fieldsOf(initialView, todayKey));
  }, [initialView, todayKey]);

  const reloadExpense = useCallback(
    async (id: string) => {
      const response = await fetch(
        `/app/areas/${CONTABILIDAD_AREA_KEY}/api/contabilidad/gastos/${encodeURIComponent(id)}`
      );
      if (!response.ok) return;
      const json = (await response.json()) as ExpenseCaptureView;
      setView(json);
      setFields(fieldsOf(json, todayKey));
    },
    [todayKey]
  );

  // While the AI is proposing the fields of a ticket, re-read the draft.
  useEffect(() => {
    if (!expense || proposalStatus(expense.aiProposal) !== 'pending') return;
    if (polls >= PROPOSAL_POLL_MAX) return;
    const timer = setTimeout(() => {
      setPolls((value) => value + 1);
      void reloadExpense(expense.id);
    }, PROPOSAL_POLL_MS);
    return () => clearTimeout(timer);
  }, [expense, polls, reloadExpense]);

  async function createDraft(captureMode: ExpenseCaptureMode): Promise<string | null> {
    const result = await run<{ expenseId?: string; number?: string }>(
      captureExpenseCommand({
        captureMode,
        rawInput: captureMode === 'form' ? null : rawInput,
        amount: fields.amount || null,
        date: fields.date || null,
        supplierNameFree: fields.supplierNameFree || null,
        categoryId: fields.categoryId || null,
        costCenterId: fields.costCenterId || null,
        cashAccountId: fields.cashAccountId || null,
        paymentMethod: fields.paymentMethod || null,
        isPaid: fields.isPaid,
        description: fields.description || null,
      }),
      'Gasto capturado'
    );
    if (!result.ok || !result.data?.expenseId) return null;
    setPolls(0);
    await reloadExpense(result.data.expenseId);
    return result.data.expenseId;
  }

  async function onPickFile(file: File) {
    if (!online) {
      toast.error('Sin conexión: el comprobante se sube cuando vuelvas a estar en línea.');
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const id = expenseId ?? (await createDraft('photo'));
      if (!id) return;
      await uploadFile(file, { target: { type: 'expense_receipt', id } });
      toast.success('Comprobante adjuntado; la IA está leyendo el ticket');
      setPolls(0);
      await reloadExpense(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo subir el comprobante');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function saveFields() {
    if (!expense) {
      await createDraft(mode === 'photo' ? 'form' : mode);
      return;
    }
    const result = await run(
      updateExpenseCommand(expense.id, expense.version, {
        amount: fields.amount || null,
        date: fields.date || null,
        supplierNameFree: fields.supplierNameFree || null,
        categoryId: fields.categoryId || null,
        costCenterId: fields.costCenterId || null,
        cashAccountId: fields.cashAccountId || null,
        paymentMethod: fields.paymentMethod || null,
        isPaid: fields.isPaid,
        description: fields.description || null,
      }),
      'Gasto actualizado'
    );
    if (result.ok) await reloadExpense(expense.id);
  }

  async function resolveDuplicate(decision: 'unique' | 'duplicate') {
    if (!expense) return;
    const result = await run(
      resolveExpenseDuplicateCommand(expense.id, expense.version, decision, expense.duplicateOfId),
      decision === 'unique' ? 'Marcado como gasto único' : 'Marcado como duplicado'
    );
    if (result.ok) await reloadExpense(expense.id);
  }

  async function submit() {
    if (!expense) return;
    const result = await run<{ submitted?: boolean; autoApproved?: boolean; status?: string }>(
      submitExpenseCommand(expense.id, expense.version),
      'Gasto enviado'
    );
    if (result.ok) {
      if (result.data?.autoApproved) toast.success('Aprobado automáticamente por política');
      await reloadExpense(expense.id);
      router.refresh();
    }
  }

  async function post() {
    if (!expense) return;
    const result = await run(
      postExpenseCommand(expense.id, expense.version, {
        cashAccountId: fields.cashAccountId || null,
      }),
      'Gasto contabilizado'
    );
    if (result.ok) await reloadExpense(expense.id);
  }

  const step = expense
    ? nextExpenseStep({
        status: expense.status,
        duplicateStatus: expense.duplicateStatus,
        amount: expense.amount,
        categoryId: expense.categoryId,
        isPaid: expense.isPaid,
        cashAccountId: expense.cashAccountId,
        receiptObjectIds: expense.receiptObjectIds,
      })
    : null;
  const proposal = expense ? proposalStatus(expense.aiProposal) : 'none';
  const proposed = expense ? proposalFields(expense.aiProposal) : [];
  const canEdit = expense ? expense.status === 'draft' : true;

  return (
    <div className="fin-capture">
      {!online ? (
        <Alert variant="info">
          Sin conexión: lo que captures se envía solo al volver; el comprobante necesita conexión.
        </Alert>
      ) : null}

      <section className="fin-card" aria-labelledby="fin-capture-title">
        <div className="fin-card-head">
          <h2 className="fin-card-title" id="fin-capture-title">
            {expense ? `Gasto ${expense.number}` : 'Capturar un gasto'}
          </h2>
          {expense ? (
            <Badge variant={BADGE_BY_TONE[expenseStatusTone(expense.status)]}>
              {expenseStatusLabel(expense.status)}
            </Badge>
          ) : null}
        </div>

        {!expense ? (
          <>
            <div className="fin-capture-modes" role="group" aria-label="Cómo quieres capturarlo">
              {MODES.map((option) => {
                const Icon = option.icon;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className="fin-capture-mode"
                    aria-pressed={mode === option.id}
                    onClick={() => setMode(option.id)}
                  >
                    <Icon size={20} aria-hidden="true" />
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className="fin-card-hint">{MODES.find((m) => m.id === mode)?.hint}</p>
          </>
        ) : null}

        {!expense && mode !== 'photo' ? (
          <FormField
            label={mode === 'voice' ? 'Dicta el gasto' : 'Escribe el gasto'}
            htmlFor="fin-raw"
            help="Por ejemplo: gasolina 800 pesos pagada con la tarjeta el martes."
          >
            <Textarea
              id="fin-raw"
              rows={3}
              maxLength={4000}
              value={rawInput}
              onChange={(event) => setRawInput(event.target.value)}
            />
          </FormField>
        ) : null}

        {!expense && mode === 'voice' ? (
          <div className="fin-capture-dictation">
            <VoiceDictationButton
              onFinalTranscript={(text) =>
                setRawInput((current) => `${current ? `${current} ` : ''}${text}`)
              }
              ariaLabel="Dictar el gasto"
            />
            <span>Habla con normalidad; puedes corregir el texto antes de capturarlo.</span>
          </div>
        ) : null}

        <div className="fin-receipts">
          <input
            ref={fileRef}
            id="fin-receipt"
            className="sr-only"
            type="file"
            accept="image/*,application/pdf"
            capture="environment"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onPickFile(file);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={uploading || busy}
            onClick={() => fileRef.current?.click()}
          >
            <Camera size={14} aria-hidden="true" />
            {uploading ? 'Subiendo…' : 'Tomar foto o subir PDF'}
          </Button>
          {expense && expense.receiptObjectIds.length > 0 ? (
            <span className="fin-muted">
              <Paperclip size={12} aria-hidden="true" /> {expense.receiptObjectIds.length}{' '}
              {expense.receiptObjectIds.length === 1 ? 'comprobante' : 'comprobantes'}
            </span>
          ) : (
            <span className="fin-muted">Sin comprobante todavía</span>
          )}
        </div>

        {error ? <Alert variant="error">{error}</Alert> : null}

        {!expense ? (
          <div className="fin-actions">
            <Button
              variant="primary"
              size="sm"
              disabled={busy || (mode !== 'photo' && rawInput.trim() === '')}
              onClick={() => createDraft(mode)}
            >
              <Send size={14} aria-hidden="true" />
              {busy ? 'Capturando…' : 'Capturar gasto'}
            </Button>
          </div>
        ) : null}
      </section>

      {expense && proposal === 'pending' ? (
        <section className="fin-proposal" aria-live="polite">
          <strong>La IA está leyendo el comprobante…</strong>
          <LoadingState variant="list" rows={2} label="Preparando la propuesta del gasto" />
        </section>
      ) : null}

      {expense && proposed.length > 0 ? (
        <section className="fin-proposal" aria-labelledby="fin-proposal-title">
          <strong id="fin-proposal-title">Propuesta de la IA</strong>
          <p className="fin-card-hint">
            Sólo llenó los campos que dejaste vacíos. Revísala y corrige lo que haga falta antes de
            enviar.
          </p>
          <dl className="fin-proposal-list">
            {proposed.map((item) => (
              <div key={item.key}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {expense && expense.duplicateStatus === 'suspect' ? (
        <Alert variant="warning" title="Parece un gasto duplicado">
          <p>
            {expense.duplicateOfNumber
              ? `Se parece a ${expense.duplicateOfNumber} (mismo importe, fecha o proveedor).`
              : 'Encontramos un gasto muy parecido ya capturado.'}{' '}
            Resuélvelo antes de enviarlo a aprobación.
          </p>
          <div className="fin-actions">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => resolveDuplicate('unique')}
            >
              Es un gasto distinto
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => resolveDuplicate('duplicate')}
            >
              Sí, ya estaba capturado
            </Button>
          </div>
        </Alert>
      ) : null}

      {expense ? (
        <section className="fin-card" aria-labelledby="fin-fields-title">
          <div className="fin-card-head">
            <h3 className="fin-card-title" id="fin-fields-title">
              Datos del gasto
            </h3>
            <span className="fin-card-hint">
              {duplicateStatusLabel(expense.duplicateStatus)} · {formatDateKey(expense.date)}
            </span>
          </div>

          <div className="fin-fields">
            <FormField label="Importe" htmlFor="fin-amount">
              <Input
                id="fin-amount"
                inputMode="decimal"
                value={fields.amount}
                disabled={!canEdit}
                onChange={(event) => setFields({ ...fields, amount: event.target.value })}
              />
            </FormField>
            <FormField label="Fecha" htmlFor="fin-date">
              <Input
                id="fin-date"
                type="date"
                value={fields.date}
                max={todayKey}
                disabled={!canEdit}
                onChange={(event) => setFields({ ...fields, date: event.target.value })}
              />
            </FormField>
            <FormField label="Proveedor" htmlFor="fin-supplier">
              <Input
                id="fin-supplier"
                value={fields.supplierNameFree}
                disabled={!canEdit}
                maxLength={200}
                onChange={(event) => setFields({ ...fields, supplierNameFree: event.target.value })}
              />
            </FormField>
            <FormField label="Categoría" htmlFor="fin-category">
              <Select
                id="fin-category"
                value={fields.categoryId}
                disabled={!canEdit}
                onChange={(event) => setFields({ ...fields, categoryId: event.target.value })}
              >
                <option value="">Sin categoría</option>
                {view.categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Centro de costo" htmlFor="fin-center">
              <Select
                id="fin-center"
                value={fields.costCenterId}
                disabled={!canEdit}
                onChange={(event) => setFields({ ...fields, costCenterId: event.target.value })}
              >
                <option value="">Sin centro</option>
                {view.costCenters.map((center) => (
                  <option key={center.id} value={center.id}>
                    {center.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Forma de pago" htmlFor="fin-method">
              <Select
                id="fin-method"
                value={fields.paymentMethod}
                disabled={!canEdit}
                onChange={(event) => setFields({ ...fields, paymentMethod: event.target.value })}
              >
                <option value="">Sin especificar</option>
                {PAYMENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {method === 'cash'
                      ? 'Efectivo'
                      : method === 'transfer'
                        ? 'Transferencia'
                        : method === 'card'
                          ? 'Tarjeta'
                          : 'Otro'}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="¿Ya está pagado?" htmlFor="fin-paid">
              <Select
                id="fin-paid"
                value={fields.isPaid ? 'si' : 'no'}
                disabled={!canEdit}
                onChange={(event) => setFields({ ...fields, isPaid: event.target.value === 'si' })}
              >
                <option value="si">Sí, ya salió el dinero</option>
                <option value="no">No, queda por pagar</option>
              </Select>
            </FormField>
            {fields.isPaid ? (
              <FormField label="Cuenta de pago" htmlFor="fin-account">
                <Select
                  id="fin-account"
                  value={fields.cashAccountId}
                  disabled={!canEdit}
                  onChange={(event) => setFields({ ...fields, cashAccountId: event.target.value })}
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
            <div className="fin-field-wide">
              <FormField label="Descripción" htmlFor="fin-description">
                <Input
                  id="fin-description"
                  value={fields.description}
                  maxLength={500}
                  disabled={!canEdit}
                  onChange={(event) => setFields({ ...fields, description: event.target.value })}
                />
              </FormField>
            </div>
          </div>

          {canEdit ? (
            <div className="fin-actions">
              <Button variant="secondary" size="sm" disabled={busy} onClick={saveFields}>
                Guardar cambios
              </Button>
            </div>
          ) : (
            <p className="fin-card-hint">
              Un gasto enviado ya no se edita: se corrige rechazándolo o, si está contabilizado, con
              un reverso.
            </p>
          )}
        </section>
      ) : null}

      {expense && step ? (
        <div className="fin-next">
          <span className="fin-next-text">
            <span className="fin-next-label">{step.label}</span>
            <span className="fin-next-detail">{step.detail}</span>
          </span>
          {step.key === 'submit' ? (
            <Button variant="primary" size="sm" disabled={busy} onClick={submit}>
              Enviar a aprobación
            </Button>
          ) : step.key === 'post' && view.capabilities.post ? (
            <Button variant="primary" size="sm" disabled={busy} onClick={post}>
              Contabilizar
            </Button>
          ) : step.key === 'receipt' ? (
            <Button
              variant="primary"
              size="sm"
              disabled={uploading || busy}
              onClick={() => fileRef.current?.click()}
            >
              Adjuntar comprobante
            </Button>
          ) : null}
        </div>
      ) : null}

      {view.recent.length > 0 ? (
        <section className="fin-card" aria-labelledby="fin-recent-title">
          <h3 className="fin-card-title" id="fin-recent-title">
            Tus gastos por cerrar
          </h3>
          <ul className="fin-cards" style={{ display: 'grid' }}>
            {view.recent.map((item) => (
              <li key={item.id} className="fin-row-card">
                <span className="fin-row-card-head">
                  <a
                    className="fin-row-card-title"
                    href={`/app/areas/${CONTABILIDAD_AREA_KEY}/gastos/nuevo?gasto=${encodeURIComponent(item.id)}`}
                  >
                    {item.number} · {item.supplierNameFree ?? item.description ?? 'Gasto'}
                  </a>
                  <span className="fin-num">{formatMoney(item.amount, item.currency)}</span>
                </span>
                <span className="fin-muted">
                  {formatDateKey(item.date)} · {expenseStatusLabel(item.status)}
                  {item.receiptObjectIds.length === 0 ? ' · sin comprobante' : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
