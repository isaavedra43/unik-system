'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Inbox, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import '@/styles/operations/ventas.css';
import type { AreaSpecialViewProps } from '@/components/areas/area-client-registry';
import { AreaCopilotPanel } from '@/components/operations/AreaCopilotPanel';
import { describeSubmitOutcome } from '@/components/operations/mywork-model';
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
import { Alert, Button, Select } from '@/components/ui/primitives';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import { stashCommsDraft } from '@/modules/areas/comms-draft';
import type { RadarBoardPayload } from '@/modules/areas/ventas/ventas-queries';
import {
  VENTAS_API,
  ventasCommsHref,
  ventasPipelineHref,
} from '@/modules/areas/ventas/ventas-constants';
import type { RadarSignalDTO } from '@/modules/crm/crm-dto';
import { RADAR_KIND_LABELS, RADAR_KINDS, type RadarKind } from '@/modules/crm/types';
import { RadarSignalRow } from './RadarSignalRow';
import {
  buildConvertCommand,
  buildDismissCommand,
  buildSnoozeCommand,
  convertError,
  defaultTaskTitle,
  dismissError,
  EMPTY_RADAR_FILTERS,
  filterSignals,
  groupSignalsByKind,
  radarCopilotContext,
  radarStarters,
  snoozeError,
  type RadarFilterState,
} from './radar-model';

/**
 * Radar de cierre (plan 7.6): las señales comerciales ordenadas por puntaje,
 * agrupadas por tipo, con su motivo en cifras y las decisiones que se pueden
 * tomar sin salir de la vista.
 *
 * - "Preparar mensaje" selecciona la señal (el copiloto del área la recibe en
 *   su contexto como `signalId`), pide la explicación y el borrador a la IA
 *   (`explainSignal`, con el presupuesto y los frenos de la capa de IA) y lo
 *   muestra para revisarlo. El envío sigue siendo de la persona, desde la
 *   conversación del cliente.
 * - Posponer, descartar y convertir en tarea viajan como comandos
 *   (`crm.radar.*`) por la cola offline: el motor revalida permiso, visibilidad
 *   y versión.
 */

const WIDE_QUERY = '(min-width: 1280px)';
const REALTIME_TYPES = ['radar_refreshed', 'signal_changed'] as const;

function useWideScreen(): boolean | null {
  const subscribe = useCallback((onChange: () => void) => {
    const media = window.matchMedia(WIDE_QUERY);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return useSyncExternalStore<boolean | null>(
    subscribe,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => null
  );
}

type PendingDialog =
  { kind: 'dismiss'; signal: RadarSignalDTO } | { kind: 'convert'; signal: RadarSignalDTO };

export function RadarCierre({ user, params }: AreaSpecialViewProps) {
  const router = useRouter();
  const { submit, online } = useOfflineCommandQueue(user.id);
  const wide = useWideScreen();

  const [board, setBoard] = useState<RadarBoardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [pendingEvents, setPendingEvents] = useState(0);
  const [filters, setFilters] = useState<RadarFilterState>(EMPTY_RADAR_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(params.signal ?? null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [explainingId, setExplainingId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotDraft, setCopilotDraft] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(VENTAS_API.radar({ estado: 'active', limit: '100' }));
      const json = (await response.json().catch(() => ({}))) as RadarBoardPayload & {
        error?: string;
      };
      if (!response.ok) throw new Error(json.error ?? 'No pudimos cargar el radar');
      setBoard(json);
      setPendingEvents(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos cargar el radar');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  useOperationsRealtime(
    ['crm:radar'],
    REALTIME_TYPES,
    useCallback(() => setPendingEvents((value) => value + 1), [])
  );

  const now = useMemo(() => (board ? new Date(board.computedAt) : new Date()), [board]);

  const visible = useMemo(
    () => (board ? filterSignals(board.signals, filters, user.id) : []),
    [board, filters, user.id]
  );
  const groups = useMemo(() => groupSignalsByKind(visible), [visible]);
  const selected = useMemo(
    () => visible.find((signal) => signal.id === selectedId) ?? null,
    [visible, selectedId]
  );

  const replaceSignal = useCallback((signal: RadarSignalDTO) => {
    setBoard((current) =>
      current
        ? {
            ...current,
            signals: current.signals.map((row) => (row.id === signal.id ? signal : row)),
          }
        : current
    );
  }, []);

  const runCommand = useCallback(
    async (
      signal: RadarSignalDTO,
      command: OfflineCommandInput<Record<string, unknown>>,
      successMessage: string
    ) => {
      setBusyId(signal.id);
      try {
        const outcome = await submit<Record<string, unknown>>(command);
        const feedback = describeSubmitOutcome(outcome, successMessage);
        if (feedback.kind === 'success') toast.success(feedback.message);
        else if (feedback.kind === 'queued') toast.info(feedback.message);
        else if (feedback.kind === 'conflict') toast.warning(feedback.message);
        else toast.error(feedback.message);
        if (feedback.refresh) setReloadToken((value) => value + 1);
        return feedback.kind === 'success' || feedback.kind === 'queued';
      } finally {
        setBusyId(null);
      }
    },
    [submit]
  );

  const explain = useCallback(
    async (signal: RadarSignalDTO) => {
      setExplainingId(signal.id);
      try {
        const response = await fetch(VENTAS_API.explainSignal(signal.id), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: Boolean(signal.aiSuggestedMessage) }),
        });
        const json = (await response.json().catch(() => ({}))) as {
          signal?: RadarSignalDTO;
          error?: string;
        };
        if (!response.ok || !json.signal) {
          throw new Error(json.error ?? 'No pudimos preparar el mensaje');
        }
        replaceSignal(json.signal);
        toast.success('Mensaje preparado: revísalo antes de enviarlo');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'No pudimos preparar el mensaje');
      } finally {
        setExplainingId(null);
      }
    },
    [replaceSignal]
  );

  /**
   * Cierra el circuito «señal → borrador → mensaje al cliente»: deja el texto en
   * la pestaña y abre la bandeja externa del área, donde `InboxEmbedded` lo
   * pone en el redactor. El borrador NUNCA viaja en la URL: es texto escrito
   * para un cliente concreto.
   */
  const sendDraftToInbox = useCallback(
    (text: string) => {
      const ok = stashCommsDraft('ventas', text, { origin: 'radar' });
      if (!ok) {
        toast.error('No pudimos guardar el borrador; cópialo y pégalo en la bandeja');
        return;
      }
      setCopilotDraft(null);
      router.push(ventasCommsHref('externos'));
    },
    [router]
  );

  const copilotContext = useCallback(
    () =>
      radarCopilotContext({
        signals: visible,
        filters,
        selected,
        total: board?.total ?? visible.length,
      }),
    [visible, filters, selected, board]
  );

  const copilot = (
    <AreaCopilotPanel
      areaKey="ventas"
      user={user}
      activityAt={board?.computedAt ?? null}
      context={copilotContext}
      starters={radarStarters(selected)}
      onInsertDraft={(text) => setCopilotDraft(text)}
      onAfterTurn={() => setReloadToken((value) => value + 1)}
      {...(wide === false ? { onBack: () => setCopilotOpen(false) } : {})}
    />
  );

  const kindOptions = useMemo(
    () =>
      RADAR_KINDS.filter((kind) =>
        board ? board.signals.some((signal) => signal.kind === kind) : false
      ),
    [board]
  );

  const salespeople = board?.summary.bySalesperson ?? [];

  return (
    <div className="ventas-radar">
      <div className="ventas-radar-main">
        <div className="ventas-toolbar" role="group" aria-label="Filtros del radar">
          <div className="ventas-field">
            <label className="form-label" htmlFor="radar-vendedor">
              Vendedor
            </label>
            <Select
              id="radar-vendedor"
              value={filters.salesperson}
              onChange={(event) =>
                setFilters((current) => ({ ...current, salesperson: event.target.value }))
              }
            >
              <option value="all">Todos</option>
              <option value="me">Mías</option>
              <option value="unassigned">Sin vendedor</option>
              {salespeople
                .filter((row) => row.userId && row.userId !== user.id)
                .map((row) => (
                  <option key={row.userId as string} value={row.userId as string}>
                    {row.name ?? 'Sin nombre'} ({row.count})
                  </option>
                ))}
            </Select>
          </div>

          <div className="ventas-field">
            <label className="form-label" htmlFor="radar-tipo">
              Tipo de señal
            </label>
            <Select
              id="radar-tipo"
              value={filters.kinds[0] ?? 'all'}
              onChange={(event) => {
                const value = event.target.value;
                setFilters((current) => ({
                  ...current,
                  kinds: value === 'all' ? [] : [value as RadarKind],
                }));
              }}
            >
              <option value="all">Todos</option>
              {kindOptions.map((kind) => (
                <option key={kind} value={kind}>
                  {RADAR_KIND_LABELS[kind]}
                </option>
              ))}
            </Select>
          </div>

          <div className="ventas-field">
            <label className="form-label" htmlFor="radar-buscar">
              Buscar
            </label>
            <input
              id="radar-buscar"
              type="search"
              placeholder="Cliente o motivo…"
              value={filters.search}
              onChange={(event) =>
                setFilters((current) => ({ ...current, search: event.target.value }))
              }
            />
          </div>

          <div className="ventas-toolbar-spacer" />

          <Link className="btn btn-secondary btn-sm" href={ventasPipelineHref()}>
            Ver embudo
          </Link>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setReloadToken((value) => value + 1)}
            title="Volver a calcular la lista con lo último del radar"
          >
            <RefreshCw size={14} aria-hidden="true" />
            Actualizar
          </Button>
          {wide === false ? (
            <Button variant="secondary" size="sm" onClick={() => setCopilotOpen(true)}>
              <Sparkles size={14} aria-hidden="true" />
              IA de Ventas
            </Button>
          ) : null}
        </div>

        {board ? (
          <p className="ventas-summary">
            <span>
              <strong>{board.summary.active}</strong> señales activas
            </span>
            <span>
              <strong>{visible.length}</strong> visibles con estos filtros
            </span>
            {!online ? <span>Sin conexión: tus decisiones se enviarán al reconectar</span> : null}
          </p>
        ) : null}

        {pendingEvents > 0 ? (
          <Alert variant="info">
            El radar se recalculó ({pendingEvents}){' '}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setReloadToken((value) => value + 1)}
            >
              Actualizar
            </button>
          </Alert>
        ) : null}

        {copilotDraft ? (
          <div className="ventas-draft">
            <span className="ventas-field-label">Borrador del copiloto</span>
            <p className="ventas-draft-text">{copilotDraft}</p>
            <div className="ventas-signal-actions">
              <Button variant="primary" size="sm" onClick={() => sendDraftToInbox(copilotDraft)}>
                <Inbox size={14} aria-hidden="true" />
                Llevar a la bandeja
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(copilotDraft).catch(() => undefined);
                  toast.success('Borrador copiado');
                }}
              >
                Copiar
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setCopilotDraft(null)}>
                Descartar
              </Button>
            </div>
          </div>
        ) : null}

        {loading ? (
          <LoadingState variant="list" rows={4} label="Cargando el radar de cierre…" />
        ) : error ? (
          <ErrorState
            title="No pudimos cargar el radar"
            message={error}
            onRetry={() => setReloadToken((value) => value + 1)}
          />
        ) : groups.length === 0 ? (
          <div className="area-empty">
            <strong>Sin señales pendientes</strong>
            <p>
              {board && board.signals.length > 0
                ? 'Ninguna señal coincide con los filtros. Quita el filtro de vendedor o de tipo para ver el resto.'
                : 'Nadie está esperando una respuesta ni hay cotizaciones por vencer. El radar se recalcula cada 15 minutos.'}
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <section
              key={group.kind}
              className="ventas-radar-group"
              aria-labelledby={`radar-group-${group.kind}`}
            >
              <div className="ventas-radar-group-head">
                <h3 id={`radar-group-${group.kind}`} className="ventas-radar-group-title">
                  {group.label}
                </h3>
                <span className="ventas-muted">
                  {group.signals.length === 1 ? '1 señal' : `${group.signals.length} señales`}
                </span>
                <span className="ventas-muted">{group.hint}</span>
              </div>
              <ul className="ventas-radar-list">
                {group.signals.map((signal) => (
                  <RadarSignalRow
                    key={signal.id}
                    signal={signal}
                    selected={signal.id === selectedId}
                    busy={busyId === signal.id}
                    explaining={explainingId === signal.id}
                    now={now}
                    onSelect={() => setSelectedId(signal.id)}
                    onPrepareMessage={() => {
                      setCopilotOpen(wide === false);
                      void explain(signal);
                    }}
                    onSnooze={(until) => {
                      const invalid = snoozeError(until, new Date());
                      if (invalid) {
                        toast.error(invalid);
                        return;
                      }
                      void runCommand(signal, buildSnoozeCommand(signal, until), 'Señal pospuesta');
                    }}
                    onDismiss={() => setDialog({ kind: 'dismiss', signal })}
                    onConvert={() => setDialog({ kind: 'convert', signal })}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      <aside className="ventas-radar-aside">{copilot}</aside>

      {wide === false ? (
        <Sheet open={copilotOpen} onOpenChange={setCopilotOpen}>
          <SheetContent side="right" className="w-full max-w-md p-0">
            <SheetTitle className="sr-only">IA de Ventas</SheetTitle>
            <SheetDescription className="sr-only">
              Copiloto del área sobre las señales visibles
            </SheetDescription>
            <div className="area-copilot-sheet">{copilot}</div>
          </SheetContent>
        </Sheet>
      ) : null}

      {dialog ? (
        <RadarDecisionDialog
          pending={dialog}
          onClose={() => setDialog(null)}
          onSubmit={async (command, message) => {
            const done = await runCommand(dialog.signal, command, message);
            if (done) setDialog(null);
            return done;
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diálogos de decisión
// ---------------------------------------------------------------------------

function toLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface RadarDecisionDialogProps {
  pending: PendingDialog;
  onClose: () => void;
  onSubmit: (
    command: OfflineCommandInput<Record<string, unknown>>,
    successMessage: string
  ) => Promise<boolean>;
}

/** Descartar (motivo) o convertir en tarea (título y vencimiento). */
function RadarDecisionDialog({ pending, onClose, onSubmit }: RadarDecisionDialogProps) {
  const isDismiss = pending.kind === 'dismiss';
  const [reason, setReason] = useState('');
  const [title, setTitle] = useState(defaultTaskTitle(pending.signal));
  const [dueAt, setDueAt] = useState(() =>
    toLocalInputValue(new Date(Date.now() + 24 * 3_600_000))
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    if (busy) return;
    const now = new Date();
    const invalid = isDismiss
      ? dismissError(reason)
      : convertError({ title, dueAt: dueAt ? new Date(dueAt).toISOString() : '' }, now);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const command = isDismiss
        ? buildDismissCommand(pending.signal, reason)
        : buildConvertCommand(pending.signal, {
            title,
            ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}),
          });
      await onSubmit(command, isDismiss ? 'Señal descartada' : 'Tarea creada desde la señal');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isDismiss ? 'Descartar la señal' : 'Convertir en tarea'}</DialogTitle>
          <DialogDescription>
            {isDismiss
              ? 'La señal deja de aparecer mientras la condición siga igual. Di por qué para que quede constancia.'
              : 'Se crea un trabajo de Ventas con esta señal y la señal se pospone hasta su vencimiento.'}
          </DialogDescription>
        </DialogHeader>

        {isDismiss ? (
          <div className="ventas-form">
            <label className="form-label" htmlFor="radar-dismiss-reason">
              Motivo (opcional)
            </label>
            <textarea
              id="radar-dismiss-reason"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ya compró con otro proveedor, pidió que no lo contactemos…"
            />
          </div>
        ) : (
          <div className="ventas-form">
            <div>
              <label className="form-label" htmlFor="radar-task-title">
                Título de la tarea
              </label>
              <input
                id="radar-task-title"
                maxLength={160}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div>
              <label className="form-label" htmlFor="radar-task-due">
                Vence
              </label>
              <input
                id="radar-task-due"
                type="datetime-local"
                value={dueAt}
                onChange={(event) => setDueAt(event.target.value)}
              />
            </div>
          </div>
        )}

        {error ? <p className="ventas-form-error">{error}</p> : null}

        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            variant={isDismiss ? 'danger' : 'primary'}
            size="sm"
            onClick={send}
            disabled={busy}
          >
            {busy ? 'Enviando…' : isDismiss ? 'Descartar' : 'Crear tarea'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
