'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Plus,
  RefreshCw,
  Sparkles,
  Truck,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { AreaCopilotPanel } from '@/components/operations/AreaCopilotPanel';
import { describeSubmitOutcome } from '@/components/operations/mywork-model';
import { useOperationsRealtime } from '@/components/operations/use-operations-realtime';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingState } from '@/components/patterns/LoadingState';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/shadcn/sheet';
import { Alert, Button, Select } from '@/components/ui/primitives';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import type { AreaSpecialViewProps } from '@/components/areas/area-client-registry';
import {
  DISPATCH_CHANNEL,
  FLEET_PATH,
  LOGISTICS_API,
  LOGISTICS_REALTIME_TYPES,
  addStopInput,
  buildMapPoints,
  cancelDeliveryInput,
  dispatchHref,
  formatDayLabel,
  groupDispatchDeliveries,
  operationDay,
  parseBoardDate,
  shiftDay,
  tripsAcceptingStops,
  type DispatchBoardData,
  type DispatchDelivery,
} from '@/modules/areas/logistica/logistics-view-model';
import { AssignTransportDialog } from './AssignTransportDialog';
import { BuildTripDialog } from './BuildTripDialog';
import { DeliveryCard } from './DeliveryCard';
import { VehicleTimeline } from './VehicleTimeline';
import '@/styles/operations/logistica.css';

/**
 * Despacho (plan 7.6): the deliveries nobody has loaded yet, the map of the day
 * and the trips of each unit. Dragging a delivery onto a unit loads it into its
 * trip; every action is a command of the engine sent through the offline queue,
 * and the pill "Escribir en Zoho" is what a person uses when Zoho answered with
 * different values.
 *
 * Full-bleed on desktop; on a phone the three columns become tabs (plan 7.10).
 */

const DispatchMap = dynamic(() => import('./DispatchMap').then((mod) => mod.DispatchMap), {
  ssr: false,
  loading: () => <LoadingState variant="list" rows={3} label="Cargando el mapa…" />,
});

type MobileTab = 'pendientes' | 'mapa' | 'viajes';

const MOBILE_TABS: Array<{ id: MobileTab; label: string }> = [
  { id: 'pendientes', label: 'Sin asignar' },
  { id: 'mapa', label: 'Mapa' },
  { id: 'viajes', label: 'Viajes' },
];

export function DispatchBoard({ user, params }: AreaSpecialViewProps) {
  const [date, setDate] = useState(() => parseBoardDate(params.fecha, new Date()));
  const [board, setBoard] = useState<DispatchBoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingEvents, setPendingEvents] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(
    typeof params.entrega === 'string' ? params.entrega : null
  );
  const [activeDeliveryId, setActiveDeliveryId] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<DispatchDelivery | null>(null);
  const [tripDialog, setTripDialog] = useState<{
    vehicleId: string | null;
    deliveryIds: string[];
  } | null>(null);
  const [tab, setTab] = useState<MobileTab>('pendientes');
  const [copilotOpen, setCopilotOpen] = useState(false);

  const { submit, online, pending } = useOfflineCommandQueue(user.id);

  const load = useCallback(async (day: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(LOGISTICS_API.board(day));
      const json = (await response.json().catch(() => ({}))) as
        (DispatchBoardData & { error?: string }) | { error?: string };
      if (!response.ok || !('deliveries' in json)) {
        throw new Error(('error' in json && json.error) || 'No pudimos cargar el despacho');
      }
      setBoard(json);
      setPendingEvents(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos cargar el despacho');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [load, date]);

  useOperationsRealtime(
    [DISPATCH_CHANNEL],
    LOGISTICS_REALTIME_TYPES,
    useCallback(() => setPendingEvents((value) => value + 1), [])
  );

  // The board has no typed state to lose: it refreshes itself right after a move.
  useEffect(() => {
    if (pendingEvents === 0) return;
    const timer = setTimeout(() => void load(date), 1200);
    return () => clearTimeout(timer);
  }, [pendingEvents, load, date]);

  const runCommand = useCallback(
    async (input: OfflineCommandInput<Record<string, unknown>>, successMessage: string) => {
      const outcome = await submit<Record<string, unknown>>(input);
      const feedback = describeSubmitOutcome(outcome, successMessage);
      if (feedback.kind === 'success') toast.success(feedback.message);
      else if (feedback.kind === 'queued') toast.info(feedback.message);
      else if (feedback.kind === 'conflict') toast.warning(feedback.message);
      else toast.error(feedback.message);
      if (feedback.refresh) void load(date);
      return feedback.kind === 'success' || feedback.kind === 'queued';
    },
    [submit, load, date]
  );

  const groups = useMemo(
    () => groupDispatchDeliveries(board?.deliveries ?? []),
    [board?.deliveries]
  );
  const points = useMemo(
    () => buildMapPoints(board?.deliveries ?? [], board?.trips ?? []),
    [board?.deliveries, board?.trips]
  );
  const openTrips = useMemo(() => tripsAcceptingStops(board?.trips ?? []), [board?.trips]);
  const fleetCandidates = useMemo(
    () => groups.unassigned.filter((delivery) => delivery.mode === 'own_fleet'),
    [groups.unassigned]
  );

  const permissions = board?.permissions;
  const canDispatch = permissions?.canDispatch ?? false;

  const copilotContext = useCallback(
    () => ({
      surface: 'area',
      areaKey: 'logistica',
      space: 'despacho',
      date,
      counters: board?.counters ?? null,
      selectedDeliveryId: selectedId,
      trips: (board?.trips ?? []).slice(0, 10).map((trip) => ({
        id: trip.id,
        number: trip.number,
        status: trip.status,
        stops: trip.stops.length,
        driver: trip.driver?.name ?? null,
      })),
      rows: (board?.deliveries ?? []).slice(0, 25).map((delivery) => ({
        id: delivery.id,
        status: delivery.status,
        statusLabel: delivery.statusLabel,
        customerName: delivery.customerName,
        caseNumber: delivery.caseNumber,
        city: delivery.address.city,
        tripNumber: delivery.tripNumber,
        zohoSyncState: delivery.zohoSyncState,
        windowEnd: delivery.windowEnd,
      })),
    }),
    [board, date, selectedId]
  );

  // dnd-kit numbers its accessibility ids from a module-level counter that does not
  // line up between the server render and the client one, so the generated
  // `aria-describedby` differed and React threw this whole subtree away and rebuilt
  // it on every load (hydration error #418). `useId` is stable across both.
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor)
  );

  function onDragStart(event: DragStartEvent) {
    setActiveDeliveryId(String(event.active.id));
  }

  async function onDragEnd(event: DragEndEvent) {
    const deliveryId = String(event.active.id);
    setActiveDeliveryId(null);
    const data = event.over?.data.current as
      { tripId?: string | null; vehicleId?: string } | undefined;
    if (!data) return;
    if (data.tripId) {
      const trip = openTrips.find((entry) => entry.id === data.tripId);
      if (!trip) return;
      await runCommand(addStopInput(trip, deliveryId), 'Entrega cargada en el viaje');
      return;
    }
    if (data.vehicleId) setTripDialog({ vehicleId: data.vehicleId, deliveryIds: [deliveryId] });
  }

  async function addToTrip(delivery: DispatchDelivery, tripId: string) {
    const trip = openTrips.find((entry) => entry.id === tripId);
    if (!trip) return;
    await runCommand(addStopInput(trip, delivery.id), 'Entrega cargada en el viaje');
  }

  async function cancelDelivery(delivery: DispatchDelivery) {
    const reason = window.prompt('¿Por qué se cancela esta entrega?')?.trim();
    if (!reason) return;
    await runCommand(cancelDeliveryInput(delivery, reason), 'Entrega cancelada');
  }

  const today = operationDay(new Date());

  return (
    <div className="dispatch">
      <div className="dispatch-toolbar">
        <div className="dispatch-toolbar-group">
          <button
            type="button"
            className="icon-btn"
            aria-label="Día anterior"
            onClick={() => setDate((current) => shiftDay(current, -1))}
          >
            <ChevronLeft size={16} />
          </button>
          <span className="dispatch-day">{formatDayLabel(date)}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Día siguiente"
            onClick={() => setDate((current) => shiftDay(current, 1))}
          >
            <ChevronRight size={16} />
          </button>
          {date !== today ? (
            <Button variant="ghost" size="sm" onClick={() => setDate(today)}>
              Hoy
            </Button>
          ) : null}
          <Link className="btn btn-ghost btn-sm" href={dispatchHref({ date })} scroll={false}>
            Enlace de este día
          </Link>
        </div>

        <div className="dispatch-toolbar-group">
          {board ? (
            <div className="dispatch-counters">
              <span className="dispatch-counter">
                Sin asignar <strong>{board.counters.unassigned}</strong>
              </span>
              <span className="dispatch-counter">
                En ruta <strong>{board.counters.inTransit}</strong>
              </span>
              <span
                className={`dispatch-counter ${board.counters.zohoPending > 0 ? 'dispatch-counter-danger' : ''}`}
              >
                Zoho <strong>{board.counters.zohoPending}</strong>
              </span>
              <span
                className={`dispatch-counter ${board.counters.failed > 0 ? 'dispatch-counter-danger' : ''}`}
              >
                Fallidas <strong>{board.counters.failed}</strong>
              </span>
            </div>
          ) : null}
          <Button variant="secondary" size="sm" onClick={() => void load(date)} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : undefined} aria-hidden="true" />
            Actualizar
          </Button>
          <Link className="btn btn-ghost btn-sm" href={FLEET_PATH}>
            <Users size={14} aria-hidden="true" />
            Flotilla
          </Link>
          {canDispatch ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setTripDialog({ vehicleId: null, deliveryIds: [] })}
            >
              <Plus size={14} aria-hidden="true" />
              Armar viaje
            </Button>
          ) : null}
          {permissions?.canUseAssistant ? (
            <Button variant="secondary" size="sm" onClick={() => setCopilotOpen(true)}>
              <Sparkles size={14} aria-hidden="true" />
              IA del área
            </Button>
          ) : null}
        </div>
      </div>

      {!online || pending > 0 ? (
        <Alert variant={online ? 'info' : 'warning'}>
          {online
            ? `${pending} ${pending === 1 ? 'acción pendiente' : 'acciones pendientes'} de enviar.`
            : `Sin conexión${pending > 0 ? ` · ${pending} pendientes` : ''}. Tus acciones se enviarán al reconectar.`}
        </Alert>
      ) : null}

      {pendingEvents > 0 ? (
        <Alert variant="info">
          Hubo movimiento en la operación; el tablero se está actualizando solo.
        </Alert>
      ) : null}

      <div className="dispatch-mobile-tabs" role="tablist" aria-label="Vistas del despacho">
        {MOBILE_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`dispatch-mobile-tab ${tab === entry.id ? 'dispatch-mobile-tab-active' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {error ? (
        <ErrorState
          title="No pudimos cargar el despacho"
          message={error}
          onRetry={() => void load(date)}
        />
      ) : loading && !board ? (
        <LoadingState variant="list" rows={6} label="Cargando las entregas del día…" />
      ) : board ? (
        <DndContext
          id={dndId}
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragEnd={(event) => void onDragEnd(event)}
        >
          <div className="dispatch-columns">
            <section
              className={`dispatch-column ${tab === 'pendientes' ? 'dispatch-column-active' : ''}`}
              aria-label="Entregas sin asignar"
            >
              <header className="dispatch-column-header">
                <h3 className="dispatch-column-title">Sin asignar</h3>
                <span className="dispatch-column-hint">{groups.unassigned.length}</span>
              </header>
              <div className="dispatch-column-body">
                {groups.unassigned.length === 0 ? (
                  <p className="dispatch-column-hint">
                    Todo lo de este día tiene transporte. Cambia de día para preparar el siguiente.
                  </p>
                ) : (
                  groups.unassigned.map((delivery) => (
                    <DraggableDelivery
                      key={delivery.id}
                      delivery={delivery}
                      canDispatch={canDispatch}
                      selected={selectedId === delivery.id}
                      onSelect={() => setSelectedId(delivery.id)}
                      onAssign={() => setAssignTarget(delivery)}
                      onCancel={() => void cancelDelivery(delivery)}
                      trips={openTrips.map((trip) => ({ id: trip.id, number: trip.number }))}
                      onAddToTrip={(tripId) => void addToTrip(delivery, tripId)}
                    />
                  ))
                )}
              </div>
            </section>

            <section
              className={`dispatch-column ${tab === 'mapa' ? 'dispatch-column-active' : ''}`}
              aria-label="Mapa de entregas"
            >
              <header className="dispatch-column-header">
                <h3 className="dispatch-column-title">Mapa del día</h3>
                <span className="dispatch-column-hint">{points.length} puntos</span>
              </header>
              <div className="dispatch-map">
                <DispatchMap
                  points={points}
                  focusDeliveryId={selectedId}
                  onSelect={(id) => setSelectedId(id)}
                />
              </div>
            </section>

            <section
              className={`dispatch-column dispatch-column-trips ${tab === 'viajes' ? 'dispatch-column-active' : ''}`}
              aria-label="Viajes y unidades"
            >
              <header className="dispatch-column-header">
                <h3 className="dispatch-column-title">Unidades y viajes</h3>
                <span className="dispatch-column-hint">
                  <Truck size={13} aria-hidden="true" /> {board.counters.tripsActive} activos
                </span>
              </header>
              <div className="dispatch-column-body">
                <VehicleTimeline
                  vehicles={board.vehicles}
                  trips={board.trips}
                  canDispatch={canDispatch}
                  onCreateTrip={(vehicleId) => setTripDialog({ vehicleId, deliveryIds: [] })}
                  activeDeliveryId={activeDeliveryId}
                />
                {groups.zohoAttention.length > 0 ? (
                  <>
                    <h4 className="dispatch-column-title">Pendientes con Zoho</h4>
                    {groups.zohoAttention.map((delivery) => (
                      <DeliveryCard
                        key={delivery.id}
                        delivery={delivery}
                        selected={selectedId === delivery.id}
                        onOpen={() => setSelectedId(delivery.id)}
                        {...(canDispatch ? { onWriteZoho: () => setAssignTarget(delivery) } : {})}
                      />
                    ))}
                  </>
                ) : null}
              </div>
            </section>
          </div>
        </DndContext>
      ) : null}

      {assignTarget && board ? (
        <AssignTransportDialog
          delivery={assignTarget}
          vehicles={board.vehicles}
          drivers={board.drivers}
          date={date}
          canWriteZoho={board.permissions.canWriteZoho}
          online={online}
          onClose={() => setAssignTarget(null)}
          onSubmit={runCommand}
        />
      ) : null}

      {tripDialog && board ? (
        <BuildTripDialog
          date={date}
          vehicles={board.vehicles}
          drivers={board.drivers}
          candidates={fleetCandidates}
          preselectedVehicleId={tripDialog.vehicleId}
          preselectedDeliveryIds={tripDialog.deliveryIds}
          canManageFleet={board.permissions.canManageFleet}
          online={online}
          onClose={() => setTripDialog(null)}
          onSubmit={runCommand}
        />
      ) : null}

      {permissions?.canUseAssistant ? (
        <Sheet open={copilotOpen} onOpenChange={setCopilotOpen}>
          <SheetContent side="right" className="w-full max-w-md p-0">
            <SheetTitle className="sr-only">IA de Logística</SheetTitle>
            <SheetDescription className="sr-only">
              Copiloto del área sobre el despacho del día
            </SheetDescription>
            <div className="area-copilot-sheet">
              <AreaCopilotPanel
                areaKey="logistica"
                user={user}
                activityAt={board?.generatedAt ?? null}
                context={copilotContext}
                onAfterTurn={() => void load(date)}
                onBack={() => setCopilotOpen(false)}
              />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}

interface DraggableDeliveryProps {
  delivery: DispatchDelivery;
  canDispatch: boolean;
  selected: boolean;
  onSelect: () => void;
  onAssign: () => void;
  onCancel: () => void;
  trips: Array<{ id: string; number: string }>;
  onAddToTrip: (tripId: string) => void;
}

function DraggableDelivery({
  delivery,
  canDispatch,
  selected,
  onSelect,
  onAssign,
  onCancel,
  trips,
  onAddToTrip,
}: DraggableDeliveryProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: delivery.id,
    disabled: !canDispatch,
  });
  const ownFleet = delivery.mode === 'own_fleet';

  return (
    <div ref={setNodeRef}>
      <DeliveryCard
        delivery={delivery}
        selected={selected}
        dragging={isDragging}
        onOpen={onSelect}
        {...(canDispatch ? { onWriteZoho: onAssign } : {})}
        handle={
          canDispatch && ownFleet ? (
            <button
              type="button"
              className="dispatch-drag-handle"
              aria-label={`Arrastrar ${delivery.customerName ?? 'la entrega'} a una unidad`}
              {...attributes}
              {...listeners}
            >
              <GripVertical size={14} />
            </button>
          ) : null
        }
        actions={
          canDispatch ? (
            <>
              <Button variant="secondary" size="sm" onClick={onAssign}>
                Asignar transporte
              </Button>
              {ownFleet && trips.length > 0 ? (
                <label className="sr-only" htmlFor={`add-trip-${delivery.id}`}>
                  Cargar en un viaje
                </label>
              ) : null}
              {ownFleet && trips.length > 0 ? (
                <Select
                  id={`add-trip-${delivery.id}`}
                  defaultValue=""
                  onChange={(event) => {
                    if (event.target.value) onAddToTrip(event.target.value);
                    event.target.value = '';
                  }}
                >
                  <option value="">Cargar en viaje…</option>
                  {trips.map((trip) => (
                    <option key={trip.id} value={trip.id}>
                      {trip.number}
                    </option>
                  ))}
                </Select>
              ) : null}
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Cancelar
              </Button>
            </>
          ) : null
        }
      />
    </div>
  );
}
