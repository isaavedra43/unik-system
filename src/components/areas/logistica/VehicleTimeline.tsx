'use client';

import Link from 'next/link';
import { useDroppable } from '@dnd-kit/core';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/primitives';
import {
  tripHref,
  tripProgress,
  type DispatchTrip,
  type DispatchVehicle,
} from '@/modules/areas/logistica/logistics-view-model';

export interface VehicleTimelineProps {
  vehicles: DispatchVehicle[];
  trips: DispatchTrip[];
  canDispatch: boolean;
  /** Opens the "armar viaje" dialog with this vehicle preselected. */
  onCreateTrip: (vehicleId: string) => void;
  /** A delivery is being dragged: the tracks light up as drop targets. */
  activeDeliveryId: string | null;
}

/**
 * Rows = vehicles, blocks = their trips of the day (plan 7.6). Dropping a
 * delivery on a track adds it to that trip (`trip.add_stop`); dropping it on a
 * vehicle with no trip opens the dialog that builds one.
 *
 * Dragging is the shortcut, never the only way: every block links to its trip
 * and each delivery card carries a "Cargar en viaje" button that does the same
 * with the keyboard.
 */
export function VehicleTimeline({
  vehicles,
  trips,
  canDispatch,
  onCreateTrip,
  activeDeliveryId,
}: VehicleTimelineProps) {
  if (vehicles.length === 0) {
    return (
      <p className="dispatch-timeline-empty">
        No hay vehículos dados de alta todavía. Agrégalos en Flotilla para armar viajes.
      </p>
    );
  }

  return (
    <div className="dispatch-timeline">
      {vehicles.map((vehicle) => {
        const vehicleTrips = trips.filter((trip) => trip.vehicle?.id === vehicle.id);
        return (
          <div key={vehicle.id} className="dispatch-timeline-row">
            <div className="dispatch-timeline-vehicle">
              <strong>{vehicle.label}</strong>
              <span className="dispatch-column-hint">
                {vehicle.code} · {vehicle.plate}
              </span>
              {!vehicle.available && vehicle.reasons.length > 0 ? (
                <span className="dispatch-column-hint">No disponible</span>
              ) : null}
            </div>
            <VehicleTrack
              vehicleId={vehicle.id}
              vehicleLabel={vehicle.label}
              trips={vehicleTrips}
              canDispatch={canDispatch}
              onCreateTrip={onCreateTrip}
              dragging={activeDeliveryId !== null}
            />
          </div>
        );
      })}
    </div>
  );
}

interface VehicleTrackProps {
  vehicleId: string;
  vehicleLabel: string;
  trips: DispatchTrip[];
  canDispatch: boolean;
  onCreateTrip: (vehicleId: string) => void;
  dragging: boolean;
}

function VehicleTrack({
  vehicleId,
  vehicleLabel,
  trips,
  canDispatch,
  onCreateTrip,
  dragging,
}: VehicleTrackProps) {
  const active = trips.find((trip) => trip.status === 'planned' || trip.status === 'en_route');
  const { setNodeRef, isOver } = useDroppable({
    id: active ? `trip:${active.id}` : `vehicle:${vehicleId}`,
    disabled: !canDispatch,
    data: { tripId: active?.id ?? null, vehicleId },
  });

  return (
    <div
      ref={setNodeRef}
      className={`dispatch-timeline-track ${isOver && dragging ? 'dispatch-timeline-track-over' : ''}`}
      aria-label={`Viajes de ${vehicleLabel}`}
    >
      {trips.length === 0 ? (
        <>
          <span className="dispatch-timeline-empty">Sin viajes este día</span>
          {canDispatch ? (
            <Button variant="secondary" size="sm" onClick={() => onCreateTrip(vehicleId)}>
              <Plus size={14} aria-hidden="true" />
              Armar viaje
            </Button>
          ) : null}
        </>
      ) : (
        trips.map((trip) => {
          const progress = tripProgress(trip.stops);
          return (
            <Link
              key={trip.id}
              href={tripHref(trip.id)}
              className={`dispatch-timeline-block dispatch-timeline-block-${trip.status}`}
            >
              <strong>{trip.number}</strong>
              <span>
                {trip.statusLabel} · {progress.label}
              </span>
              {trip.driver ? <span>{trip.driver.name}</span> : null}
              <span className="dispatch-progress" aria-hidden="true">
                <span className="dispatch-progress-bar" style={{ width: `${progress.percent}%` }} />
              </span>
            </Link>
          );
        })
      )}
    </div>
  );
}
