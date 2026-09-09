'use client';

import React, { useState, useCallback } from 'react';
import { X, Calendar } from 'lucide-react';

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
    <div className="chat-dialog-overlay" onClick={onCancel}>
      <div className="chat-dialog chat-event-creator" onClick={(e) => e.stopPropagation()}>
        <div className="chat-dialog-header">
          <h2>
            <Calendar size={20} /> Crear evento
          </h2>
          <button type="button" onClick={onCancel} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>

        <div className="chat-event-creator-body">
          <input
            type="text"
            className="chat-event-title-input"
            placeholder="Título del evento"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />

          <textarea
            className="chat-event-desc-input"
            placeholder="Descripción (opcional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={2000}
          />

          <label className="chat-event-field-label">Inicio</label>
          <input
            type="datetime-local"
            className="chat-event-starts-at"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />

          <label className="chat-event-field-label">Fin (opcional)</label>
          <input
            type="datetime-local"
            className="chat-event-ends-at"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />

          <input
            type="text"
            className="chat-event-location-input"
            placeholder="Ubicación (opcional)"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            maxLength={300}
          />

          {error && <div className="chat-dialog-error">{error}</div>}
        </div>

        <div className="chat-dialog-footer">
          <button type="button" className="chat-event-cancel-btn" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="chat-event-create-btn" onClick={handleCreate}>
            Crear evento
          </button>
        </div>
      </div>
    </div>
  );
}
