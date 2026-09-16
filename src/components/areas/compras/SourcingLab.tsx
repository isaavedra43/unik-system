'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { AreaCopilotPanel } from '@/components/operations/AreaCopilotPanel';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingState } from '@/components/patterns/LoadingState';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/shadcn/sheet';
import { Alert, Button, FormField, Input, Select } from '@/components/ui/primitives';
import type { AreaSpecialViewProps } from '@/components/areas/area-client-registry';
import { useOperationsRealtime } from '@/components/operations/use-operations-realtime';
import {
  MAX_COMPARED_CANDIDATES,
  purchasesBoardTouches,
  sourcingProgress,
  toggleComparedCandidate,
} from '@/modules/areas/compras/compras-model';
import {
  PURCHASES_BOARD_CHANNEL,
  PURCHASES_REALTIME_TYPE,
} from '@/modules/purchases/purchases-types';
import {
  createSupplierAction,
  promoteCandidateAction,
  requestQuoteFromCandidatesAction,
  runSourcingSearchAction,
  updateCandidateStatusAction,
} from './compras-actions';
import { SourcingCandidateCard } from './SourcingCandidateCard';
import { SourcingCompare } from './SourcingCompare';
import {
  PromoteSupplierDialog,
  NewSupplierDialog,
  RequestQuoteDialog,
  type NewSupplierValues,
  type PromoteSupplierValues,
  type RequestQuoteValues,
} from './SourcingDialogs';
import type { SourcingCandidateView, SourcingLabData } from './sourcing-types';

/**
 * Laboratorio de Sourcing — specialized view of Compras (plan 7.6).
 *
 * Search suppliers on the web or in an authorized catalog, read the candidates
 * with the evidence behind them, compare up to four, ask them for a quotation
 * through the inbox and promote the good ones to suppliers of UNIK.
 *
 * What it reuses instead of re-implementing: the search, the RFQ and the
 * promotion are the existing `purchases` commands (through the area server
 * actions), the candidates come from `purchases-queries`, and the area copilot
 * is the shared `AreaCopilotPanel` — here with the candidate as its context.
 *
 * Budget and cache belong to the domain: a repeated query answers from the
 * cache without spending, and the remaining budget of the day is always shown
 * so nobody burns it by accident.
 */

const POLL_INTERVAL_MS = 3_000;
const MAX_POLLS = 20;

type StatusFilter = 'todos' | 'new' | 'contacted' | 'approved' | 'rejected';

const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'todos', label: 'Todos' },
  { value: 'new', label: 'Nuevos' },
  { value: 'contacted', label: 'Contactados' },
  { value: 'approved', label: 'Aprobados' },
  { value: 'rejected', label: 'Descartados' },
];

export function SourcingLab({ areaKey, user, canAct, params }: AreaSpecialViewProps) {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<'brave_search' | 'catalog_page'>('brave_search');
  const [catalogUrl, setCatalogUrl] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('todos');
  const [excludeKnown, setExcludeKnown] = useState(false);
  const [searchId, setSearchId] = useState<string | null>(params.busqueda ?? null);

  const [data, setData] = useState<SourcingLabData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [quoteFor, setQuoteFor] = useState<SourcingCandidateView[] | null>(null);
  const [promoteFor, setPromoteFor] = useState<SourcingCandidateView | null>(null);
  const [newSupplierOpen, setNewSupplierOpen] = useState(false);
  const [aiFor, setAiFor] = useState<SourcingCandidateView | null>(null);

  const pollsRef = useRef(0);

  const endpoint = useMemo(() => {
    const search = new URLSearchParams();
    if (searchId) search.set('searchId', searchId);
    if (statusFilter !== 'todos') search.set('status', statusFilter);
    if (excludeKnown) search.set('excludeKnown', '1');
    search.set('pageSize', '24');
    return `/app/areas/${encodeURIComponent(areaKey)}/api/compras/sourcing?${search.toString()}`;
  }, [areaKey, searchId, statusFilter, excludeKnown]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch(endpoint, { headers: { accept: 'application/json' } });
      const json = (await response.json()) as SourcingLabData & { error?: string };
      if (!response.ok) throw new Error(json.error ?? 'No pudimos cargar el laboratorio');
      setData(json);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'No pudimos cargar el laboratorio');
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  /**
   * `purchases:board` (plan 6.6): the background search, the promotion of a
   * candidate and every change of status publish there. Listening to it is what
   * makes the lab move by itself; the polling below stays as the fallback for a
   * browser without SSE and for a job that finishes while the tab is asleep.
   *
   * Nothing typed is lost: `load()` only replaces the candidates, never the
   * query box nor the comparison the person is building.
   */
  useOperationsRealtime(
    [PURCHASES_BOARD_CHANNEL],
    [PURCHASES_REALTIME_TYPE],
    useCallback(
      (_type, data) => {
        if (!purchasesBoardTouches(data, { searchId, anySourcing: true })) return;
        pollsRef.current = 0;
        setReloadToken((value) => value + 1);
      },
      [searchId]
    )
  );

  /** The search job runs in the background: follow it until it finishes. */
  const activeSearch = useMemo(
    () => data?.searches.find((entry) => entry.id === searchId) ?? null,
    [data, searchId]
  );
  const progress = activeSearch
    ? sourcingProgress({
        status: activeSearch.status,
        resultCount: activeSearch.resultCount,
        error: activeSearch.error,
      })
    : null;

  useEffect(() => {
    if (!progress?.running) {
      pollsRef.current = 0;
      return;
    }
    if (pollsRef.current >= MAX_POLLS) return;
    const timer = setTimeout(() => {
      pollsRef.current += 1;
      setReloadToken((value) => value + 1);
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [progress?.running, reloadToken]);

  async function submitSearch() {
    if (searching) return;
    setSearchError(null);
    setSearching(true);
    try {
      const result = await runSourcingSearchAction({
        query,
        providerKey: provider,
        urls: provider === 'catalog_page' && catalogUrl.trim() ? [catalogUrl.trim()] : [],
        refresh: false,
      });
      if (!result.ok) {
        setSearchError(result.error);
        return;
      }
      setSearchId(result.data.searchId);
      pollsRef.current = 0;
      setReloadToken((value) => value + 1);
      toast.success(
        result.data.cached
          ? 'Ya teníamos esta búsqueda: te mostramos el resultado guardado, sin gastar presupuesto.'
          : 'Búsqueda en curso; te mostramos los candidatos en cuanto lleguen.'
      );
    } finally {
      setSearching(false);
    }
  }

  function toggleCompare(candidate: SourcingCandidateView) {
    const result = toggleComparedCandidate(selected, candidate.id);
    setSelected(result.selected);
    if (!result.ok) toast.warning(result.error);
  }

  async function submitQuote(values: RequestQuoteValues) {
    if (!quoteFor) return;
    setBusy(true);
    setDialogError(null);
    try {
      const result = await requestQuoteFromCandidatesAction({
        candidateIds: quoteFor.map((candidate) => candidate.id),
        ...values,
      });
      if (!result.ok) {
        setDialogError(result.error);
        return;
      }
      setQuoteFor(null);
      setSelected([]);
      setReloadToken((value) => value + 1);
      toast.success(
        result.data.failed > 0
          ? `Cotización ${result.data.number}: enviada a ${result.data.sent}, ${result.data.failed} no salieron.`
          : `Cotización ${result.data.number} enviada a ${result.data.sent} proveedor(es).`
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitPromotion(values: PromoteSupplierValues) {
    if (!promoteFor) return;
    setBusy(true);
    setDialogError(null);
    try {
      const result = await promoteCandidateAction({
        candidateId: promoteFor.id,
        name: values.name,
        paymentMode: values.paymentMode,
        paymentTermsDays: values.paymentTermsDays,
        leadTimeDaysDefault: values.leadTimeDaysDefault,
      });
      if (!result.ok) {
        setDialogError(result.error);
        return;
      }
      setPromoteFor(null);
      setReloadToken((value) => value + 1);
      toast.success(
        result.data.created
          ? `${result.data.name} es ahora el proveedor ${result.data.number}.`
          : `Lo vinculamos con el proveedor ${result.data.number} que ya existía.`
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitNewSupplier(values: NewSupplierValues) {
    setBusy(true);
    setDialogError(null);
    try {
      const result = await createSupplierAction(values);
      if (!result.ok) {
        setDialogError(result.error);
        return;
      }
      setNewSupplierOpen(false);
      setReloadToken((value) => value + 1);
      toast.success(`${result.data.name} se creó como proveedor ${result.data.number}.`);
    } finally {
      setBusy(false);
    }
  }

  async function discard(candidate: SourcingCandidateView) {
    setBusy(true);
    try {
      const result = await updateCandidateStatusAction({
        candidateId: candidate.id,
        status: 'rejected',
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setReloadToken((value) => value + 1);
      toast.success(`${candidate.name} quedó descartado.`);
    } finally {
      setBusy(false);
    }
  }

  const comparing = useMemo(
    () => (data?.candidates ?? []).filter((candidate) => selected.includes(candidate.id)),
    [data, selected]
  );

  /** Context the area copilot gets in this view: the candidate being asked about. */
  const copilotContext = useCallback(
    () => ({
      surface: 'sourcing',
      areaKey,
      searchId,
      candidateId: aiFor?.id ?? null,
      candidate: aiFor
        ? {
            id: aiFor.id,
            name: aiFor.name,
            domain: aiFor.domain,
            status: aiFor.status,
            confidence: aiFor.confidence,
            evidence: aiFor.evidence.length,
            products: aiFor.productsSummary,
          }
        : null,
      visibleCandidates: (data?.candidates ?? []).slice(0, 10).map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        status: candidate.status,
      })),
    }),
    [areaKey, searchId, aiFor, data]
  );

  const config = data?.config ?? null;
  const candidates = data?.candidates ?? [];

  return (
    <div className="compras-lab">
      <section className="compras-lab-form" aria-label="Buscar proveedores">
        <div className="compras-lab-row">
          <FormField label="¿Qué necesitas comprar?" htmlFor="sourcing-query">
            <Input
              id="sourcing-query"
              value={query}
              maxLength={200}
              placeholder="Lámina galvanizada calibre 22 en Monterrey"
              leftIcon={<Search size={14} aria-hidden="true" />}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitSearch();
              }}
            />
          </FormField>

          <FormField label="Dónde buscar" htmlFor="sourcing-provider">
            <Select
              id="sourcing-provider"
              value={provider}
              onChange={(event) =>
                setProvider(event.target.value as 'brave_search' | 'catalog_page')
              }
            >
              <option value="brave_search">Búsqueda web</option>
              <option value="catalog_page">Catálogo de proveedor</option>
            </Select>
          </FormField>

          <Button
            variant="primary"
            onClick={() => void submitSearch()}
            isLoading={searching}
            disabled={!canAct || query.trim().length < 3}
            title={
              canAct ? 'Buscar proveedores' : 'No tienes permiso para buscar en el laboratorio'
            }
          >
            Buscar
          </Button>
        </div>

        {provider === 'catalog_page' ? (
          <FormField
            label="Dirección del catálogo"
            htmlFor="sourcing-url"
            help="Sólo se leen sitios autorizados por Administración."
          >
            <Input
              id="sourcing-url"
              value={catalogUrl}
              maxLength={500}
              placeholder="https://proveedor.com/catalogo"
              onChange={(event) => setCatalogUrl(event.target.value)}
            />
          </FormField>
        ) : null}

        {searchError ? <Alert variant="error">{searchError}</Alert> : null}

        {progress ? (
          <p className={`compras-lab-status compras-lab-status-${progress.tone}`}>
            {progress.label}
          </p>
        ) : null}

        {config ? (
          <p className="compras-lab-hint">
            {config.enabled
              ? `Quedan ${config.remainingBudget} de ${config.dailyBudgetUnits} unidades de búsqueda hoy · una consulta repetida en los últimos ${config.cacheTtlDays} días no gasta.`
              : 'El laboratorio está desactivado: pide a Administración que lo habilite.'}
          </p>
        ) : null}
      </section>

      <div className="compras-lab-toolbar">
        <div className="area-chip-group" role="group" aria-label="Filtrar candidatos">
          <span className="area-chip-group-label">Estado</span>
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={`area-chip ${statusFilter === filter.value ? 'area-chip-active' : ''}`.trim()}
              aria-pressed={statusFilter === filter.value}
              onClick={() => setStatusFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
          <button
            type="button"
            className={`area-chip ${excludeKnown ? 'area-chip-active' : ''}`.trim()}
            aria-pressed={excludeKnown}
            title="Ocultar los que ya son proveedores de UNIK"
            onClick={() => setExcludeKnown((value) => !value)}
          >
            Sólo nuevos para UNIK
          </button>
          {searchId ? (
            <button
              type="button"
              className="area-chip"
              onClick={() => setSearchId(null)}
              title="Ver los candidatos de todas las búsquedas"
            >
              Ver todos
            </button>
          ) : null}
        </div>
        <span className="compras-lab-count">
          {data ? `${data.pagination.total} candidatos` : ''}
        </span>
        {canAct ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setDialogError(null);
              setNewSupplierOpen(true);
            }}
          >
            Dar de alta proveedor
          </Button>
        ) : null}
      </div>

      <SourcingCompare
        candidates={comparing}
        canAct={canAct}
        busy={busy}
        onRemove={(candidate) => toggleCompare(candidate)}
        onRequestQuote={(list) => {
          setDialogError(null);
          setQuoteFor(list);
        }}
        onClear={() => setSelected([])}
      />

      {loading ? (
        <LoadingState variant="list" rows={4} label="Cargando los candidatos…" />
      ) : loadError ? (
        <ErrorState
          title="No pudimos cargar el laboratorio"
          message={loadError}
          onRetry={() => setReloadToken((value) => value + 1)}
        />
      ) : candidates.length === 0 ? (
        <div className="compras-empty">
          <strong>Todavía no hay candidatos</strong>
          <p>
            Busca lo que necesitas comprar y revisa los proveedores que encontremos, con la
            evidencia de dónde salió cada dato.
          </p>
        </div>
      ) : (
        <div className="compras-candidates">
          {candidates.map((candidate) => (
            <SourcingCandidateCard
              key={candidate.id}
              candidate={candidate}
              selected={selected.includes(candidate.id)}
              canAct={canAct}
              busy={busy}
              onToggleCompare={toggleCompare}
              onRequestQuote={(entry) => {
                setDialogError(null);
                setQuoteFor([entry]);
              }}
              onPromote={(entry) => {
                setDialogError(null);
                setPromoteFor(entry);
              }}
              onDiscard={(entry) => void discard(entry)}
              onAskAi={(entry) => setAiFor(entry)}
            />
          ))}
        </div>
      )}

      {selected.length >= MAX_COMPARED_CANDIDATES ? (
        <p className="compras-lab-hint">
          Estás comparando el máximo de {MAX_COMPARED_CANDIDATES}: quita uno para agregar otro.
        </p>
      ) : null}

      {quoteFor ? (
        <RequestQuoteDialog
          candidates={quoteFor}
          defaultDueDays={config?.rfqDefaultDueDays ?? 3}
          busy={busy}
          error={dialogError}
          onClose={() => setQuoteFor(null)}
          onSubmit={(values) => void submitQuote(values)}
        />
      ) : null}

      {promoteFor ? (
        <PromoteSupplierDialog
          candidate={promoteFor}
          busy={busy}
          error={dialogError}
          onClose={() => setPromoteFor(null)}
          onSubmit={(values) => void submitPromotion(values)}
        />
      ) : null}

      {newSupplierOpen ? (
        <NewSupplierDialog
          busy={busy}
          error={dialogError}
          onClose={() => setNewSupplierOpen(false)}
          onSubmit={(values) => void submitNewSupplier(values)}
        />
      ) : null}

      <Sheet open={aiFor !== null} onOpenChange={(open) => !open && setAiFor(null)}>
        <SheetContent side="right" className="area-copilot-sheet">
          <SheetTitle>IA de Compras</SheetTitle>
          <SheetDescription>
            {aiFor ? `Sobre ${aiFor.name}` : 'Sobre el laboratorio de sourcing'}
          </SheetDescription>
          {aiFor ? (
            <AreaCopilotPanel
              areaKey="compras"
              user={{ id: user.id, name: user.name }}
              activityAt={aiFor.updatedAt}
              context={copilotContext}
              starters={[
                `¿Me conviene ${aiFor.name}?`,
                '¿Qué le pregunto antes de comprarle?',
                'Prepara la solicitud de cotización',
                '¿Qué riesgo tiene un proveedor nuevo?',
              ]}
              onBack={() => setAiFor(null)}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      {!canAct ? (
        <p className="compras-lab-hint">
          <Sparkles size={12} aria-hidden="true" /> Puedes consultar el laboratorio; para buscar,
          cotizar o dar de alta proveedores necesitas permisos de Compras.
        </p>
      ) : null}
    </div>
  );
}
