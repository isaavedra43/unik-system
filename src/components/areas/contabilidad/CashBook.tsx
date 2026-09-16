'use client';

import '@/styles/operations/contabilidad.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import type { AreaSpecialViewProps } from '@/components/areas/area-client-registry';
import { AreaCopilotPanel } from '@/components/operations/AreaCopilotPanel';
import { useOperationsRealtime } from '@/components/operations/use-operations-realtime';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingState } from '@/components/patterns/LoadingState';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/shadcn/sheet';
import { Alert, Button, FormField, Input, Textarea } from '@/components/ui/primitives';
import { useIsMobile } from '@/hooks/use-is-mobile';
import type { CashBookRow } from '@/modules/finance/cashflow-service';
import type { FinanceCapabilities } from '@/modules/areas/contabilidad/queries';
import type { CashBookView, FinanceSummaryView } from '@/modules/areas/contabilidad/queries';
import {
  CONTABILIDAD_AREA_KEY,
  formatDateKey,
  periodKeyOf,
  visibleContabilidadSections,
} from '@/modules/areas/contabilidad/contabilidad-model';
import { BudgetVsActualCard } from './BudgetVsActualCard';
import { CashAccountsStrip } from './CashAccountsStrip';
import { CloseChecklistCard } from './CloseChecklistCard';
import { ContabilidadSectionNav } from './ContabilidadSectionNav';
import { LedgerTable } from './LedgerTable';
import { reverseEntryCommand } from './contabilidad-ui-model';
import { useFinanceCommand } from './use-finance-command';

/**
 * Libro de caja (plan 7.6): los saldos de las cuentas, la tabla del libro con
 * sus filtros y su paginación ("Revertir" con motivo y permiso), el presupuesto
 * contra el real y el checklist del cierre con los bloqueos resaltados.
 *
 * Es la vista especial del área, así que vive dentro del espacio de
 * Contabilidad y lee sus datos de las APIs del área; ninguna regla de negocio
 * está aquí: el reverso es el comando `finance.ledger.reverse` por la cola
 * offline y el motor lo revalida.
 *
 * En ≤768 px la tabla se sustituye por la lista equivalente (CSS) y la IA del
 * área se abre en una hoja a pantalla completa.
 */

const REALTIME_TYPES = ['finance.expense', 'finance.close', 'finance.obligation'] as const;
const MIN_REASON = 3;

interface State {
  book: CashBookView | null;
  summary: FinanceSummaryView | null;
  loading: boolean;
  error: string | null;
}

function api(path: string): string {
  return `/app/areas/${CONTABILIDAD_AREA_KEY}/api/contabilidad/${path}`;
}

export function CashBook({ user, canAct, params }: AreaSpecialViewProps) {
  const isMobile = useIsMobile();
  const { run, busy, online } = useFinanceCommand(user.id);

  const [accountId, setAccountId] = useState<string | null>(params.cuenta ?? null);
  const [from, setFrom] = useState<string>(params.desde ?? '');
  const [to, setTo] = useState<string>(params.hasta ?? '');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<State>({
    book: null,
    summary: null,
    loading: true,
    error: null,
  });
  const [pendingReverse, setPendingReverse] = useState<CashBookRow | null>(null);
  const [reason, setReason] = useState('');
  const [reverseError, setReverseError] = useState<string | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [movements, setMovements] = useState(0);

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const search = new URLSearchParams();
      if (accountId) search.set('cuenta', accountId);
      if (from) search.set('desde', from);
      if (to) search.set('hasta', to);
      if (page > 1) search.set('pagina', String(page));
      const [bookResponse, summaryResponse] = await Promise.all([
        fetch(api(`libro?${search.toString()}`)),
        fetch(api('resumen')),
      ]);
      const bookJson = (await bookResponse.json().catch(() => ({}))) as CashBookView & {
        error?: string;
      };
      if (!bookResponse.ok) throw new Error(bookJson.error ?? 'No pudimos cargar el libro');
      const summaryJson = summaryResponse.ok
        ? ((await summaryResponse.json()) as FinanceSummaryView)
        : null;
      setState({ book: bookJson, summary: summaryJson, loading: false, error: null });
      setMovements(0);
      if (!accountId && bookJson.accountId) setAccountId(bookJson.accountId);
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : 'No pudimos cargar el libro',
      }));
    }
  }, [accountId, from, to, page]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  useOperationsRealtime(
    [`finance:board`],
    REALTIME_TYPES,
    useCallback(() => setMovements((value) => value + 1), [])
  );

  const book = state.book;
  const summary = state.summary;
  const periodKey = summary?.periodKey ?? periodKeyOf(new Date());

  const copilotContext = useCallback(
    () => ({
      surface: 'area',
      areaKey: CONTABILIDAD_AREA_KEY,
      space: 'libro',
      account: book?.book
        ? {
            id: book.book.account.id,
            name: book.book.account.name,
            currency: book.book.account.currency,
            openingBalance: book.book.openingBalance,
            closingBalance: book.book.closingBalance,
            totalIn: book.book.totalIn,
            totalOut: book.book.totalOut,
            from: book.book.from,
            to: book.book.to,
            movements: book.book.total,
          }
        : null,
      budget: summary?.budget
        ? { periodKey: summary.periodKey, totals: summary.budget.totals }
        : null,
      close: {
        dailyPeriodKey: summary?.dailyTargetKey ?? null,
        dailyStatus: summary?.daily?.status ?? null,
        dailyBlockers:
          summary?.daily?.checks
            .filter((check) => !check.ok && check.blocking)
            .map((c) => c.label) ?? [],
        monthlyPeriodKey: summary?.monthly?.periodKey ?? null,
        monthlyStatus: summary?.monthly?.status ?? null,
      },
    }),
    [book, summary]
  );

  const activityAt = book?.book?.rows[0]?.date ?? null;

  // The section links follow what this person may actually open, so a link of
  // Contabilidad never lands on a 404.
  const sections = useMemo(() => {
    const capabilities: FinanceCapabilities | undefined = book?.capabilities;
    if (!capabilities) return [];
    const keys = [
      capabilities.view ? 'finance.view' : null,
      capabilities.capture ? 'finance.capture_expense' : null,
      capabilities.manageObligations ? 'finance.manage_obligations' : null,
      capabilities.payroll ? 'finance.payroll' : null,
      capabilities.close ? 'finance.close' : null,
      capabilities.manageCatalog ? 'finance.manage_catalog' : null,
    ].filter((key): key is string => key !== null);
    return visibleContabilidadSections({ permissionKeys: keys, isSuperAdmin: false });
  }, [book?.capabilities]);

  async function confirmReverse() {
    if (!pendingReverse) return;
    if (reason.trim().length < MIN_REASON) {
      setReverseError('Escribe el motivo del reverso (mínimo 3 caracteres)');
      return;
    }
    const result = await run(
      reverseEntryCommand(pendingReverse.entryId, reason),
      `Asiento ${pendingReverse.number} reversado`
    );
    if (result.ok) {
      setPendingReverse(null);
      setReason('');
      setReverseError(null);
      setReload((value) => value + 1);
    }
  }

  const copilot = (
    <AreaCopilotPanel
      areaKey={CONTABILIDAD_AREA_KEY}
      user={user}
      activityAt={activityAt}
      context={copilotContext}
      starters={[
        '¿Qué pagos vencen esta semana?',
        '¿Qué bloquea el cierre de hoy?',
        '¿En qué categoría nos estamos pasando del presupuesto?',
        '¿Qué gastos no tienen comprobante?',
      ]}
      onAfterTurn={() => setReload((value) => value + 1)}
      {...(isMobile ? { onBack: () => setCopilotOpen(false) } : {})}
    />
  );

  return (
    <div className="fin-page">
      <ContabilidadSectionNav sections={sections} activeId="libro" />

      <div className="fin-toolbar">
        <div className="fin-toolbar-field">
          <label htmlFor="fin-from">Desde</label>
          <Input
            id="fin-from"
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="fin-toolbar-field">
          <label htmlFor="fin-to">Hasta</label>
          <Input
            id="fin-to"
            type="date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <Button variant="secondary" size="sm" onClick={() => setReload((value) => value + 1)}>
          <RefreshCw size={14} aria-hidden="true" />
          Actualizar
        </Button>
        {isMobile ? (
          <Button variant="secondary" size="sm" onClick={() => setCopilotOpen(true)}>
            <Sparkles size={14} aria-hidden="true" />
            IA del área
          </Button>
        ) : null}
      </div>

      {movements > 0 ? (
        <Alert variant="info">
          Hubo movimientos nuevos en Contabilidad.{' '}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setReload((value) => value + 1)}
          >
            Actualizar
          </button>
        </Alert>
      ) : null}

      {!online ? (
        <Alert variant="info">
          Sin conexión: puedes consultar lo ya cargado; los reversos se enviarán al volver.
        </Alert>
      ) : null}

      {state.loading && !book ? (
        <LoadingState variant="kpi" rows={4} label="Cargando los saldos…" />
      ) : state.error ? (
        <ErrorState
          title="No pudimos cargar el libro de caja"
          message={state.error}
          onRetry={() => setReload((value) => value + 1)}
        />
      ) : book ? (
        <div className="fin-columns">
          <div className="fin-section">
            <CashAccountsStrip
              accounts={book.accounts}
              selectedId={book.accountId}
              busy={state.loading}
              onSelect={(id) => {
                setAccountId(id);
                setPage(1);
              }}
            />

            {book.note ? <Alert variant="warning">{book.note}</Alert> : null}

            {book.book ? (
              <section className="fin-section" aria-label="Movimientos del libro">
                <LedgerTable
                  book={book.book}
                  canReverse={book.capabilities.post && canAct}
                  busy={busy}
                  onReverse={(row) => {
                    setPendingReverse(row);
                    setReason('');
                    setReverseError(null);
                  }}
                />
                {book.book.pageCount > 1 ? (
                  <div className="fin-pager">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={book.book.page <= 1 || state.loading}
                      onClick={() => setPage((value) => Math.max(1, value - 1))}
                    >
                      Anterior
                    </Button>
                    <span>
                      Página {book.book.page} de {book.book.pageCount} · {book.book.total}{' '}
                      movimientos
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={book.book.page >= book.book.pageCount || state.loading}
                      onClick={() => setPage((value) => value + 1)}
                    >
                      Siguiente
                    </Button>
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>

          <div className="fin-section">
            <BudgetVsActualCard periodKey={periodKey} comparison={summary?.budget ?? null} />
            <CloseChecklistCard
              kind="daily"
              periodKey={summary?.dailyTargetKey ?? ''}
              status={summary?.daily?.status ?? null}
              checks={summary?.daily?.checks ?? []}
            />
            <CloseChecklistCard
              kind="monthly"
              periodKey={summary?.monthly?.periodKey ?? periodKey}
              status={summary?.monthly?.status ?? null}
              checks={summary?.monthly?.checks ?? []}
            />
          </div>
        </div>
      ) : null}

      {!isMobile ? <aside className="area-workspace-aside">{copilot}</aside> : null}

      {isMobile ? (
        <Sheet open={copilotOpen} onOpenChange={setCopilotOpen}>
          <SheetContent side="right" className="w-full max-w-md p-0">
            <SheetTitle className="sr-only">IA de Contabilidad</SheetTitle>
            <SheetDescription className="sr-only">
              Copiloto del área sobre el libro de caja
            </SheetDescription>
            <div className="area-copilot-sheet">{copilot}</div>
          </SheetContent>
        </Sheet>
      ) : null}

      {pendingReverse ? (
        <Dialog
          open
          onOpenChange={(open) => (!open && !busy ? setPendingReverse(null) : undefined)}
        >
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Revertir el asiento {pendingReverse.number}</DialogTitle>
              <DialogDescription>
                {pendingReverse.description} · {formatDateKey(pendingReverse.date)}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <Alert variant="warning">
                Un asiento no se edita: se corrige con un reverso que queda registrado junto al
                original.
              </Alert>
              <FormField
                label="Motivo"
                htmlFor="fin-reverse-reason"
                help="Queda en la bitácora y en el asiento de reverso (hasta 500 caracteres)."
              >
                <Textarea
                  id="fin-reverse-reason"
                  rows={3}
                  maxLength={500}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  autoFocus
                />
              </FormField>
              {reverseError ? <Alert variant="error">{reverseError}</Alert> : null}
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setPendingReverse(null)}
              >
                Cancelar
              </Button>
              <Button variant="danger" size="sm" disabled={busy} onClick={confirmReverse}>
                {busy ? 'Enviando…' : 'Revertir'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
