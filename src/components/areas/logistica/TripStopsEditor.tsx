'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, GripVertical, MapPin, Navigation } from 'lucide-react';
import { Badge, Button } from '@/components/ui/primitives';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import {
  formatEta,
  formatWindow,
  navigationUrl,
  reorderStopsInput,
  stopStatusTone,
  type DispatchDelivery,
  type DispatchStop,
  type DispatchTrip,
} from '@/modules/areas/logistica/logistics-view-model';
import { ZohoSyncPill } from './ZohoSyncPill';

export interface TripStopsEditorProps {
  trip: DispatchTrip;
  deliveries: DispatchDelivery[];
  canDispatch: boolean;
  now: Date;
  onSubmit: (
    input: OfflineCommandInput<Record<string, unknown>>,
    successMessage: string
  ) => Promise<boolean>;
}

const BADGE_BY_TONE = {
  default: 'default',
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  info: 'info',
  weak: 'weak',
} as const;

/**
 * Stops of a trip in the order the driver will follow (plan 7.6). Visited stops
 * are fixed — the engine rejects moving them — so only the pending ones can be
 * reordered, by dragging or with the "Subir" / "Bajar" buttons, which is what
 * makes this usable with the keyboard and on a phone.
 *
 * The new order is saved with one `trip.reorder` command carrying every stop id.
 */
export function TripStopsEditor({
  trip,
  deliveries,
  canDispatch,
  now,
  onSubmit,
}: TripStopsEditorProps) {
  const [order, setOrder] = useState<string[]>(() => trip.stops.map((stop) => stop.id));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setOrder(trip.stops.map((stop) => stop.id));
  }, [trip.stops]);

  const byId = useMemo(() => new Map(trip.stops.map((stop) => [stop.id, stop])), [trip.stops]);
  const deliveryById = useMemo(
    () => new Map(deliveries.map((delivery) => [delivery.id, delivery])),
    [deliveries]
  );
  const stops = order
    .map((id) => byId.get(id))
    .filter((stop): stop is DispatchStop => Boolean(stop));
  const firstMovable = stops.findIndex((stop) => stop.status === 'pending');
  const dirty = order.some((id, index) => trip.stops[index]?.id !== id);
  const editable = canDispatch && (trip.status === 'planned' || trip.status === 'en_route');

  // dnd-kit numbers its accessibility ids from a module-level counter that does not
  // line up between the server render and the client one, so the generated
  // `aria-describedby` differed and React threw this whole subtree away and rebuilt
  // it on every load (hydration error #418). `useId` is stable across both.
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < firstMovable || target >= stops.length || firstMovable < 0) return;
    setOrder((current) => {
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = order.indexOf(String(active.id));
    const to = order.indexOf(String(over.id));
    if (from < 0 || to < 0 || from < firstMovable || to < firstMovable) return;
    setOrder((current) => {
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const done = await onSubmit(reorderStopsInput(trip, order), 'Orden de las paradas guardado');
      if (!done) setOrder(trip.stops.map((stop) => stop.id));
    } finally {
      setSaving(false);
    }
  }

  if (trip.stops.length === 0) {
    return (
      <p className="dispatch-column-hint">
        Este viaje todavía no tiene paradas. Agrégalas desde Despacho arrastrando una entrega a la
        unidad o con el botón «Cargar en viaje».
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      {editable && dirty ? (
        <div className="dispatch-card-actions">
          <Button variant="primary" size="sm" onClick={save} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar el orden'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setOrder(trip.stops.map((stop) => stop.id))}
            disabled={saving}
          >
            Deshacer
          </Button>
        </div>
      ) : null}

      <DndContext
        id={dndId}
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <ol className="trip-stops">
            {stops.map((stop, index) => (
              <SortableStop
                key={stop.id}
                stop={stop}
                position={index + 1}
                delivery={deliveryById.get(stop.deliveryOrderId) ?? null}
                now={now}
                editable={editable && stop.status === 'pending'}
                canMoveUp={index > firstMovable && firstMovable >= 0}
                canMoveDown={index >= firstMovable && index < stops.length - 1 && firstMovable >= 0}
                onMoveUp={() => move(index, -1)}
                onMoveDown={() => move(index, 1)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    </div>
  );
}

interface SortableStopProps {
  stop: DispatchStop;
  position: number;
  delivery: DispatchDelivery | null;
  now: Date;
  editable: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function SortableStop({
  stop,
  position,
  delivery,
  now,
  editable,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
}: SortableStopProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stop.id,
    disabled: !editable,
  });
  const eta = formatEta(stop, delivery?.windowEnd ?? null, now);
  const navigate = delivery
    ? navigationUrl(delivery.coordinates, {
        line: delivery.address.line,
        city: delivery.address.city,
        state: delivery.address.state,
      })
    : null;

  return (
    <li
      ref={setNodeRef}
      className={`trip-stop ${isDragging ? 'trip-stop-dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <span className="trip-stop-seq" aria-hidden="true">
        {position}
      </span>

      <div className="trip-stop-main">
        <span className="trip-stop-title">
          {delivery?.customerName ?? delivery?.caseNumber ?? 'Entrega'}
        </span>
        <span className="trip-stop-meta">
          <span>
            <MapPin size={13} aria-hidden="true" />{' '}
            {[delivery?.address.line, delivery?.address.city].filter(Boolean).join(', ') ||
              'Sin dirección'}
          </span>
          <span>{eta.label}</span>
          {delivery ? (
            <span>{formatWindow(delivery.windowStart, delivery.windowEnd) ?? ''}</span>
          ) : null}
          {delivery && delivery.lines.length > 0 ? (
            <span>
              {delivery.lines.length} {delivery.lines.length === 1 ? 'línea' : 'líneas'}
            </span>
          ) : null}
        </span>
        {delivery ? (
          <span className="trip-evidence">
            <ZohoSyncPill delivery={delivery} />
            {delivery.receivedBy ? <span>Recibió {delivery.receivedBy}</span> : null}
            {delivery.partialReason ? <span>Parcial: {delivery.partialReason}</span> : null}
          </span>
        ) : null}
      </div>

      <div className="trip-stop-side">
        <Badge variant={BADGE_BY_TONE[stopStatusTone(stop.status)]}>{stop.statusLabel}</Badge>
        {navigate ? (
          <a
            className="btn btn-ghost btn-sm"
            href={navigate}
            target="_blank"
            rel="noreferrer"
            aria-label={`Cómo llegar a ${delivery?.customerName ?? 'la parada'}`}
          >
            <Navigation size={14} aria-hidden="true" />
            Cómo llegar
          </a>
        ) : null}
        {editable ? (
          <span className="trip-stop-move">
            <button
              type="button"
              className="icon-btn"
              aria-label={`Subir la parada ${position}`}
              onClick={onMoveUp}
              disabled={!canMoveUp}
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Bajar la parada ${position}`}
              onClick={onMoveDown}
              disabled={!canMoveDown}
            >
              <ArrowDown size={14} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Arrastrar la parada ${position}`}
              {...attributes}
              {...listeners}
            >
              <GripVertical size={14} />
            </button>
          </span>
        ) : null}
      </div>
    </li>
  );
}
