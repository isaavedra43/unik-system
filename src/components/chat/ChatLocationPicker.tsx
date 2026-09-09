'use client';

import React, { useState, useCallback } from 'react';
import { MapPin, Send, X, Loader2 } from 'lucide-react';

export interface ChatLocationPickerProps {
  onSend: (location: { latitude: number; longitude: number; label?: string }) => void;
  onCancel: () => void;
}

export function ChatLocationPicker({ onSend, onCancel }: ChatLocationPickerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [label, setLabel] = useState('');

  const getLocation = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setError('La geolocalización no está disponible en este navegador');
      return;
    }
    setLoading(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCoords({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
        setLoading(false);
      },
      (err) => {
        let message = 'No se pudo obtener la ubicación';
        if (err.code === err.PERMISSION_DENIED) {
          message = 'Permiso de ubicación denegado';
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          message = 'Ubicación no disponible';
        } else if (err.code === err.TIMEOUT) {
          message = 'Tiempo de espera agotado';
        }
        setError(message);
        setLoading(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }, []);

  const handleSend = useCallback(() => {
    if (!coords) return;
    onSend({ ...coords, label: label.trim() || undefined });
  }, [coords, label, onSend]);

  return (
    <div className="chat-dialog-overlay" onClick={onCancel}>
      <div className="chat-dialog chat-location-picker" onClick={(e) => e.stopPropagation()}>
        <div className="chat-dialog-header">
          <h2>Compartir ubicación</h2>
          <button type="button" onClick={onCancel} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>

        <div className="chat-location-picker-body">
          {!coords && !loading && !error && (
            <button type="button" className="chat-location-get-btn" onClick={getLocation}>
              <MapPin size={18} /> Obtener mi ubicación
            </button>
          )}

          {loading && (
            <div className="chat-location-loading">
              <Loader2 size={20} className="spin" /> Obteniendo ubicación...
            </div>
          )}

          {error && (
            <div className="chat-location-error">
              {error}
              <button type="button" onClick={getLocation}>
                Reintentar
              </button>
            </div>
          )}

          {coords && (
            <>
              <div className="chat-location-preview">
                <MapPin size={18} />
                <div className="chat-location-coords">
                  <span>Latitud: {coords.latitude.toFixed(6)}</span>
                  <span>Longitud: {coords.longitude.toFixed(6)}</span>
                </div>
              </div>
              <input
                type="text"
                className="chat-location-label-input"
                placeholder="Etiqueta (opcional)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={200}
              />
            </>
          )}
        </div>

        <div className="chat-dialog-footer">
          <button type="button" className="chat-dialog-cancel" onClick={onCancel}>
            Cancelar
          </button>
          <button
            type="button"
            className="chat-location-send"
            disabled={!coords}
            onClick={handleSend}
          >
            <Send size={16} /> Enviar
          </button>
        </div>
      </div>
    </div>
  );
}
