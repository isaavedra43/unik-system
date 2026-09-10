'use client';

import React, { useState, useCallback } from 'react';
import { MapPin, Send, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/shadcn/dialog';
import { Input } from '@/components/shadcn/input';
import { Button } from '@/components/shadcn/button';

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
    <Dialog open onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Compartir ubicación</DialogTitle>
          <DialogDescription>Comparte tu ubicación actual</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {!coords && !loading && !error && (
            <Button onClick={getLocation} className="w-full">
              <MapPin size={18} /> Obtener mi ubicación
            </Button>
          )}

          {loading && (
            <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 size={20} className="animate-spin" /> Obteniendo ubicación...
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center gap-2 rounded-md bg-destructive/10 p-4 text-sm text-destructive">
              {error}
              <Button variant="outline" size="sm" onClick={getLocation}>
                Reintentar
              </Button>
            </div>
          )}

          {coords && (
            <>
              <div className="flex items-center gap-3 rounded-md border border-border p-3">
                <MapPin size={18} className="text-primary shrink-0" />
                <div className="flex flex-col text-sm">
                  <span className="text-foreground">Latitud: {coords.latitude.toFixed(6)}</span>
                  <span className="text-foreground">Longitud: {coords.longitude.toFixed(6)}</span>
                </div>
              </div>
              <Input
                type="text"
                placeholder="Etiqueta (opcional)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={200}
              />
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancelar
          </Button>
          <Button disabled={!coords} onClick={handleSend}>
            <Send size={16} /> Enviar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
