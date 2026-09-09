'use client';

import React, { useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface ChatLocationMapProps {
  latitude: number;
  longitude: number;
  label?: string | null;
}

// Create a custom div icon using an emoji pin to avoid missing default marker assets.
const markerIcon = L.divIcon({
  html: '📍',
  className: 'chat-map-marker',
  iconSize: [30, 30],
  iconAnchor: [15, 30],
});

export function ChatLocationMap({ latitude, longitude, label }: ChatLocationMapProps) {
  // Ensure default icon options are merged (in case other code relies on defaults).
  useEffect(() => {
    L.Icon.Default.mergeOptions({
      iconUrl: '/leaflet/marker-icon.png',
      iconRetinaUrl: '/leaflet/marker-icon-2x.png',
      shadowUrl: '/leaflet/marker-shadow.png',
    });
  }, []);

  const position: L.LatLngExpression = [latitude, longitude];

  return (
    <div className="chat-location-map">
      <MapContainer
        center={position}
        zoom={15}
        className="chat-map-container"
        style={{ height: '200px', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Marker position={position} icon={markerIcon}>
          {label ? (
            <Popup>
              <span>{label}</span>
            </Popup>
          ) : (
            <Popup>
              <span>
                {latitude.toFixed(6)}, {longitude.toFixed(6)}
              </span>
            </Popup>
          )}
        </Marker>
      </MapContainer>
    </div>
  );
}
