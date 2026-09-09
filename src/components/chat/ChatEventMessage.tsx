'use client';

import React, { useCallback } from 'react';
import { Calendar, MapPin } from 'lucide-react';

export interface ChatEventMessageProps {
  event: {
    id: string;
    title: string;
    description: string | null;
    startsAt: string;
    endsAt: string | null;
    location: string | null;
    rsvpCounts: { yes: number; no: number; maybe: number };
    userRsvp: string | null;
  };
  onRsvp: (status: 'yes' | 'no' | 'maybe') => void;
}

function formatEventDate(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ChatEventMessage({ event, onRsvp }: ChatEventMessageProps) {
  const handleRsvp = useCallback(
    (status: 'yes' | 'no' | 'maybe') => {
      onRsvp(status);
    },
    [onRsvp]
  );

  const rsvpButtons: { status: 'yes' | 'no' | 'maybe'; label: string; count: number }[] = [
    { status: 'yes', label: 'Sí', count: event.rsvpCounts.yes },
    { status: 'no', label: 'No', count: event.rsvpCounts.no },
    { status: 'maybe', label: 'Tal vez', count: event.rsvpCounts.maybe },
  ];

  return (
    <div className="chat-event-message">
      <div className="chat-event-title">
        <Calendar size={16} />
        <span>{event.title}</span>
      </div>

      {event.description && <div className="chat-event-desc">{event.description}</div>}

      <div className="chat-event-date">{formatEventDate(event.startsAt)}</div>

      {event.location && (
        <div className="chat-event-location">
          <MapPin size={14} /> {event.location}
        </div>
      )}

      <div className="chat-event-rsvp">
        {rsvpButtons.map((btn) => (
          <button
            key={btn.status}
            type="button"
            className={`chat-event-rsvp-btn ${event.userRsvp === btn.status ? 'chat-event-rsvp-active' : ''}`}
            onClick={() => handleRsvp(btn.status)}
          >
            {btn.label}
            <span className="chat-event-rsvp-count">{btn.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
