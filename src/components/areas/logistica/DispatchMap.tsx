'use client';

import { useEffect, useMemo } from 'react';
import L from 'leaflet';
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import {
  buildTripLines,
  fitMapView,
  type MapPoint,
} from '@/modules/areas/logistica/logistics-view-model';

export interface DispatchMapProps {
  points: MapPoint[];
  /** Delivery highlighted right now (selected on the board). */
  focusDeliveryId?: string | null;
  onSelect?: (deliveryOrderId: string) => void;
}

/**
 * Map of the dispatch board (plan 7.6): a marker per stop, the polyline of each
 * trip in stop order, and grey pins for the deliveries nobody has loaded yet.
 *
 * Loaded with `dynamic(..., { ssr: false })` from the board, like
 * `ChatLocationMap`: Leaflet needs a real DOM. Only numbers reach the marker
 * HTML; every text written by a person is rendered as React children inside the
 * popup, never as markup.
 */

const TONE_CLASS: Record<string, string> = {
  success: 'dispatch-pin-success',
  danger: 'dispatch-pin-danger',
  info: 'dispatch-pin-info',
  weak: 'dispatch-pin-weak',
};

function pinIcon(point: MapPoint): L.DivIcon {
  const tone = TONE_CLASS[point.tone] ?? '';
  const label = point.kind === 'stop' && point.sequence !== null ? String(point.sequence) : '';
  return L.divIcon({
    html: `<span class="dispatch-pin ${tone}">${label}</span>`,
    className: 'dispatch-pin-wrap',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

/** Nombre accesible del pin: «Parada 3: Cliente, Ciudad». */
function pinLabel(point: MapPoint): string {
  const stop = point.kind === 'stop' && point.sequence !== null ? `Parada ${point.sequence}: ` : '';
  return `${stop}${point.label}`;
}

/** Keeps the viewport on the markers while they change, without fighting the user. */
function MapView({
  points,
  focusDeliveryId,
}: {
  points: MapPoint[];
  focusDeliveryId?: string | null;
}) {
  const map = useMap();
  const view = useMemo(() => fitMapView(points), [points]);
  const focus = focusDeliveryId
    ? points.find((point) => point.deliveryOrderId === focusDeliveryId)
    : undefined;

  useEffect(() => {
    if (focus) {
      map.setView([focus.lat, focus.lng], Math.max(map.getZoom(), 14));
      return;
    }
    map.setView([view.center.lat, view.center.lng], view.zoom);
  }, [map, view, focus]);

  return null;
}

export function DispatchMap({ points, focusDeliveryId, onSelect }: DispatchMapProps) {
  const lines = useMemo(() => buildTripLines(points), [points]);
  const initial = useMemo(() => fitMapView(points), [points]);

  if (points.length === 0) {
    return (
      <p className="dispatch-map-placeholder">
        Ninguna entrega de este día tiene coordenadas todavía. Captúralas en la orden de venta o en
        la entrega para verlas en el mapa.
      </p>
    );
  }

  return (
    <div className="dispatch-map-canvas">
      <MapContainer
        center={[initial.center.lat, initial.center.lng]}
        zoom={initial.zoom}
        scrollWheelZoom
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapView points={points} focusDeliveryId={focusDeliveryId ?? null} />
        {lines.map((line) => (
          <Polyline
            key={line.tripId}
            positions={line.positions}
            pathOptions={{ weight: 3, opacity: 0.8 }}
          />
        ))}
        {points.map((point) => (
          <Marker
            key={point.id}
            position={[point.lat, point.lng]}
            icon={pinIcon(point)}
            // Leaflet marca cada marcador con role="button" y tabindex=0: sin
            // esto un lector de pantalla sólo anuncia «botón» (el número del
            // pin va en el HTML del icono, y las entregas sin asignar ni eso).
            alt={pinLabel(point)}
            title={pinLabel(point)}
            eventHandlers={onSelect ? { click: () => onSelect(point.deliveryOrderId) } : undefined}
          >
            <Popup>
              <span>{point.label}</span>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
