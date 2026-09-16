'use client';

import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { ChevronLeft, ChevronRight, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingState } from '@/components/patterns/LoadingState';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/shadcn/sheet';
import { Button, Select } from '@/components/ui/primitives';
import { AreaCopilotPanel } from '@/components/operations/AreaCopilotPanel';
import { useOperationsRealtime } from '@/components/operations/use-operations-realtime';
import { describeSubmitOutcome } from '@/components/operations/mywork-model';
import type { AreaSpecialViewProps } from '@/components/areas/area-client-registry';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import {
  BOARD_LANES,
  BOARD_LANE_HINTS,
  BOARD_LANE_LABELS,
  buildScheduleCommand,
  canMoveOrder,
  formatPercent,
  groupByLane,
  isRealMove,
  nextCenterIndex,
  type BoardCard as BoardCardData,
  type BoardCenter,
  type BoardPayload,
  type MoveTarget,
} from '@/modules/areas/manufactura/board-model';
import {
  MANUFACTURING_BOM_PATH,
  MANUFACTURING_NEW_ORDER_PATH,
  MANUFACTURING_REALTIME_TYPES,
  MANUFACTURING_WORK_CENTERS_PATH,
} from '@/modules/manufacturing/manufacturing-types';
import '@/styles/operations/manufactura.css';
import { BoardCard } from './BoardCard';
import { CapacityBar } from './CapacityBar';
import { MoveOrderDialog } from './MoveOrderDialog';

/**
 * Tablero de producción (plan 7.6, full-bleed): one column per work centre with
 * the load of its shifts and its orders in lanes (bloqueadas, en cola, en curso,
 * para liberar).
 *
 * Moving a card to another centre runs the REAL command of the module,
 * `manufacturing.order.schedule`, through the shared offline queue: the service
 * re-plans the pending operations against the shifts of the destination and
 * raises the overload warning when they no longer fit. There is no
 * per-operation reschedule command in the module, so the board never pretends
 * to offer one.
 *
 * ≤768 (plan 7.10) it collapses to one centre at a time with previous / next.
 */

const REALTIME_TYPES = [
  MANUFACTURING_REALTIME_TYPES.orders,
  MANUFACTURING_REALTIME_TYPES.workCenters,
  MANUFACTURING_REALTIME_TYPES.capacity,
] as const;

const BOARD_STARTERS = [
  '¿Qué centro está sobrecargado hoy?',
  '¿Qué órdenes están detenidas por material?',
  '¿Qué reprogramo primero?',
  '¿Qué puedo liberar hoy?',
] as const;

const DAY_OPTIONS = [1, 3, 7, 14];
const MOBILE_QUERY = '(max-width: 768px)';
const CONTEXT_CARDS = 25;

/** `null` until the browser answers (server render and hydration). */
function useIsMobile(): boolean | null {
  const subscribe = useCallback((onChange: () => void) => {
    const media = window.matchMedia(MOBILE_QUERY);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return useSyncExternalStore<boolean | null>(
    subscribe,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => null
  );
}

function CenterColumn({
  center,
  now,
  canAct,
  onMove,
}: {
  center: BoardCenter;
  now: Date;
  canAct: boolean;
  onMove: (card: BoardCardData) => void;
}) {
  const droppableId = center.id ?? 'unassigned';
  const { setNodeRef, isOver } = useDroppable({
    id: droppableId,
    // `manufacturing.order.schedule` always assigns a centre: it can never unassign one.
    disabled: center.id === null,
    data: { centerId: center.id },
  });
  const lanes = groupByLane(center.cards);
  const peak = center.summary?.peakUtilizationPct ?? null;

  return (
    <section
      ref={setNodeRef}
      className={`mfg-center${isOver ? ' mfg-center-drop' : ''}${center.id === null ? ' mfg-center-blocked' : ''}`}
      aria-label={`Centro ${center.name}, ${center.cards.length} órdenes`}
    >
      <header className="mfg-center-header">
        <h3 className="mfg-center-title">
          <span className="mfg-center-name" title={center.name}>
            {center.name}
          </span>
          <span className="mfg-center-meta">{center.cards.length}</span>
        </h3>
        <p className="mfg-center-meta">
          {center.id === null
            ? 'Programa estas órdenes en un centro para que entren a la carga'
            : `${center.capacityPerShift.toLocaleString('es-MX')} ${center.capacityUnitLabel} por turno${
                peak !== null ? ` · pico ${formatPercent(peak)}` : ''
              }`}
        </p>
      </header>

      {center.id === null ? (
        <p className="mfg-capacity-empty">Sin centro asignado.</p>
      ) : (
        <CapacityBar
          windows={center.windows}
          capacityUnitLabel={center.capacityUnitLabel}
          centerName={center.name}
        />
      )}

      <div className="mfg-lanes">
        {BOARD_LANES.map((lane) => (
          <div key={lane}>
            <h4 className="mfg-lane-title" title={BOARD_LANE_HINTS[lane]}>
              {BOARD_LANE_LABELS[lane]}
              <span className="mfg-lane-count">{lanes[lane].length}</span>
            </h4>
            {lanes[lane].length === 0 ? (
              <p className="mfg-lane-empty">Nada aquí.</p>
            ) : (
              <ul className="mfg-lane-cards">
                {lanes[lane].map((card) => (
                  <BoardCard key={card.id} card={card} now={now} canAct={canAct} onMove={onMove} />
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function ProductionBoard({ areaKey, user, canAct, params }: AreaSpecialViewProps) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const { submit, online } = useOfflineCommandQueue(user.id);

  const initialDays = Number.parseInt(params.dias ?? '', 10);
  const [days, setDays] = useState(DAY_OPTIONS.includes(initialDays) ? initialDays : 3);
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingEvents, setPendingEvents] = useState(0);
  const [centerIndex, setCenterIndex] = useState(0);
  const [pendingMove, setPendingMove] = useState<BoardCardData | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/app/areas/${encodeURIComponent(areaKey)}/api/manufactura/board?days=${days}`,
        { credentials: 'same-origin' }
      );
      const json = (await response.json().catch(() => ({}))) as {
        board?: BoardPayload;
        error?: string;
      };
      if (!response.ok || !json.board) {
        throw new Error(json.error ?? 'No pudimos cargar el tablero de producción');
      }
      setBoard(json.board);
      setPendingEvents(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos cargar el tablero de producción');
    } finally {
      setLoading(false);
    }
  }, [areaKey, days]);

  useEffect(() => {
    void load();
  }, [load]);

  useOperationsRealtime(
    ['manufacturing:floor', `area:${areaKey}`],
    REALTIME_TYPES,
    useCallback(() => setPendingEvents((value) => value + 1), [])
  );

  const centers = useMemo(() => board?.centers ?? [], [board]);
  const now = useMemo(() => (board ? new Date(board.generatedAt) : new Date()), [board]);

  useEffect(() => {
    if (centerIndex > centers.length - 1) setCenterIndex(0);
  }, [centers.length, centerIndex]);

  const runMove = useCallback(
    async (card: BoardCardData, target: MoveTarget): Promise<boolean> => {
      const check = canMoveOrder(card);
      if (!check.ok) {
        toast.warning(check.reason ?? 'Esta orden no puede cambiar de centro');
        return false;
      }
      const outcome = await submit<Record<string, unknown>>(buildScheduleCommand(card, target));
      const feedback = describeSubmitOutcome(outcome, `${card.number} reprogramada`);
      if (feedback.kind === 'success') toast.success(feedback.message);
      else if (feedback.kind === 'queued') toast.info(feedback.message);
      else if (feedback.kind === 'conflict') toast.warning(feedback.message);
      else toast.error(feedback.message);
      if (feedback.refresh) {
        await load();
        router.refresh();
      }
      return feedback.kind === 'success' || feedback.kind === 'queued';
    },
    [submit, load, router]
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const card = event.active.data.current?.card as BoardCardData | undefined;
      const centerId = event.over?.data.current?.centerId as string | null | undefined;
      if (!card || !event.over || centerId === undefined || centerId === null) return;
      const target: MoveTarget = { workCenterId: centerId };
      if (!isRealMove(card, target)) return;
      void runMove(card, target);
    },
    [runMove]
  );

  // dnd-kit numbers its accessibility ids from a module-level counter that does not
  // line up between the server render and the client one, so the generated
  // `aria-describedby` differed and React threw this whole subtree away and rebuilt
  // it on every load (hydration error #418). `useId` is stable across both.
  const dndId = useId();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const copilotContext = useCallback(
    () => ({
      surface: 'area',
      areaKey,
      space: 'tablero',
      days,
      totals: board?.totals ?? null,
      centers: centers.map((center) => ({
        name: center.name,
        orders: center.cards.length,
        peakUtilizationPct: center.summary?.peakUtilizationPct ?? null,
        overloadedWindows: center.summary?.overloadedWindows ?? 0,
      })),
      cards: centers
        .flatMap((center) => center.cards)
        .slice(0, CONTEXT_CARDS)
        .map((card) => ({
          number: card.number,
          status: card.status,
          lane: card.lane,
          workCenter: card.workCenterName,
          plannedEndAt: card.plannedEndAt,
          blockedReason: card.blockedReason,
          caseNumber: card.caseNumber,
        })),
    }),
    [areaKey, days, board, centers]
  );

  if (loading && !board) {
    return <LoadingState variant="list" rows={4} label="Cargando el tablero de producción…" />;
  }

  if (error && !board) {
    return (
      <ErrorState
        title="No pudimos cargar el tablero"
        message={error}
        onRetry={() => void load()}
      />
    );
  }

  if (!board) return null;

  const mobile = isMobile === true;
  const visibleCenters =
    mobile && centers.length > 0 ? [centers[Math.min(centerIndex, centers.length - 1)]] : centers;
  const activeCenter = visibleCenters[0];

  const copilot = (
    <AreaCopilotPanel
      areaKey={areaKey as Parameters<typeof AreaCopilotPanel>[0]['areaKey']}
      user={user}
      activityAt={board.generatedAt}
      context={copilotContext}
      starters={BOARD_STARTERS}
      onAfterTurn={() => void load()}
      onBack={() => setCopilotOpen(false)}
    />
  );

  return (
    <div className="mfg-board">
      <div className="mfg-board-toolbar">
        <div className="mfg-board-totals">
          <span className="mfg-total">
            <strong>{board.totals.orders}</strong> órdenes
          </span>
          <span className="mfg-total mfg-total-danger">
            <strong>{board.totals.blocked}</strong> bloqueadas
          </span>
          <span className="mfg-total">
            <strong>{board.totals.active}</strong> en curso
          </span>
          <span className="mfg-total mfg-total-warning">
            <strong>{board.totals.done}</strong> para liberar
          </span>
          {board.totals.unassigned > 0 ? (
            <span className="mfg-total">
              <strong>{board.totals.unassigned}</strong> sin centro
            </span>
          ) : null}
        </div>

        <span className="mfg-board-toolbar-spacer" />

        <label className="mfg-center-meta" htmlFor="mfg-board-days">
          Turnos de
        </label>
        <Select
          id="mfg-board-days"
          value={String(days)}
          onChange={(event) => setDays(Number(event.target.value))}
          style={{ width: 'auto' }}
        >
          {DAY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option === 1 ? 'hoy' : `${option} días`}
            </option>
          ))}
        </Select>

        <Button variant="secondary" size="sm" onClick={() => void load()}>
          <RefreshCw size={14} aria-hidden="true" />
          {pendingEvents > 0
            ? `${pendingEvents} ${pendingEvents === 1 ? 'movimiento' : 'movimientos'} · Actualizar`
            : 'Actualizar'}
        </Button>

        <Button variant="secondary" size="sm" onClick={() => setCopilotOpen(true)}>
          <Sparkles size={14} aria-hidden="true" />
          IA del área
        </Button>

        {/*
          Única entrada a la gestión de listas de materiales desde el área: la
          página existía (`/app/manufacturing/bom`) y nada la enlazaba, así que
          crear, versionar, activar o retirar una receta exigía teclear la URL.
          Desde ahí la tira de secciones lleva a Centros de trabajo.
        */}
        <Link className="btn btn-secondary btn-sm" href={MANUFACTURING_BOM_PATH}>
          Listas de materiales
        </Link>

        <Link className="btn btn-primary btn-sm" href={MANUFACTURING_NEW_ORDER_PATH}>
          Nueva orden
        </Link>
      </div>

      {board.truncated ? (
        <p className="mfg-section-hint">
          El tablero muestra las órdenes más prioritarias de cada estado; el resto sigue en el
          centro de trabajo del área.
        </p>
      ) : null}

      {centers.length === 0 ? (
        <div className="mfg-empty">
          <strong>Todavía no hay nada en el piso</strong>
          <p>
            Cuando exista una orden de producción abierta aparecerá aquí, en la columna de su centro
            de trabajo.
          </p>
          <p>
            <Link href={MANUFACTURING_WORK_CENTERS_PATH}>Configura los centros y sus turnos</Link>{' '}
            para ver la carga por turno, y crea la primera orden desde “Nueva orden”.
          </p>
        </div>
      ) : (
        <>
          {mobile && activeCenter ? (
            <div className="mfg-mobile-nav">
              <Button
                variant="secondary"
                size="sm"
                aria-label="Centro anterior"
                onClick={() =>
                  setCenterIndex((index) => nextCenterIndex(index, -1, centers.length))
                }
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </Button>
              <span className="mfg-mobile-nav-label">
                {activeCenter.name} · {centerIndex + 1}/{centers.length}
              </span>
              <Button
                variant="secondary"
                size="sm"
                aria-label="Centro siguiente"
                onClick={() => setCenterIndex((index) => nextCenterIndex(index, 1, centers.length))}
              >
                <ChevronRight size={16} aria-hidden="true" />
              </Button>
            </div>
          ) : null}

          <DndContext
            id={dndId}
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <div className="mfg-board-centers">
              {visibleCenters.map((center) => (
                <CenterColumn
                  key={center.id ?? 'unassigned'}
                  center={center}
                  now={now}
                  canAct={canAct}
                  onMove={setPendingMove}
                />
              ))}
            </div>
          </DndContext>
        </>
      )}

      {pendingMove ? (
        <MoveOrderDialog
          card={pendingMove}
          centers={centers}
          online={online}
          onClose={() => setPendingMove(null)}
          onSubmit={runMove}
        />
      ) : null}

      <Sheet open={copilotOpen} onOpenChange={setCopilotOpen}>
        <SheetContent side="right" className="w-full max-w-md p-0">
          <SheetTitle className="sr-only">IA de Manufactura</SheetTitle>
          <SheetDescription className="sr-only">
            Copiloto del área sobre el tablero de producción visible
          </SheetDescription>
          <div className="area-copilot-sheet">{copilot}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
