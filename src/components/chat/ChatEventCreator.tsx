'use client';

import React, { useState, useCallback } from 'react';
import { Calendar } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/shadcn/dialog';
import { Input } from '@/components/shadcn/input';
import { Textarea } from '@/components/shadcn/textarea';
import { Button } from '@/components/shadcn/button';

export interface ChatEventCreatorProps {
  onCreate: (event: {
    title: string;
    description?: string;
    startsAt: string;
    endsAt?: string;
    location?: string;
  }) => void;
  onCancel: () => void;
}

export function ChatEventCreator({ onCreate, onCancel }: ChatEventCreatorProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [location, setLocation] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(() => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError('Escribe un título');
      return;
    }
    if (!startsAt) {
      setError('Selecciona la fecha de inicio');
      return;
    }
    if (endsAt && new Date(endsAt) < new Date(startsAt)) {
      setError('La fecha de fin no puede ser anterior al inicio');
      return;
    }
    setError(null);
    onCreate({
      title: trimmedTitle,
      description: description.trim() || undefined,
      startsAt,
      endsAt: endsAt || undefined,
      location: location.trim() || undefined,
    });
  }, [title, description, startsAt, endsAt, location, onCreate]);

  return (
    <Dialog open onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calendar size={18} /> Crear evento
          </DialogTitle>
          <DialogDescription>Crea un evento para esta conversación</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Input
            type="text"
            placeholder="Título del evento"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />

          <Textarea
            placeholder="Descripción (opcional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={2000}
          />

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">Inicio</label>
            <Input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">Fin (opcional)</label>
            <Input
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </div>

          <Input
            type="text"
            placeholder="Ubicación (opcional)"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            maxLength={300}
          />

          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancelar
          </Button>
          <Button onClick={handleCreate}>Crear evento</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
