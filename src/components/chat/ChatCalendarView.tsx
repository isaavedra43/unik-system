'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { X, ChevronLeft, ChevronRight, Calendar as CalendarIcon, Loader2 } from 'lucide-react';

export interface ChatCalendarViewProps {
  onClose: () => void;
  onSelectEvent?: (eventId: string) => void;
}

interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
}

const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MONTH_NAMES = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];

function getMonthGrid(year: number, month: number): Date[] {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);

  // Monday = 0 ... Sunday = 6
  let firstWeekday = firstDay.getDay() - 1;
  if (firstWeekday < 0) firstWeekday = 6;

  const days: Date[] = [];
  // Leading days from previous month
  for (let i = 0; i < firstWeekday; i++) {
    const d = new Date(year, month, -firstWeekday + i + 1);
    days.push(d);
  }
  // Current month days
  for (let d = 1; d <= lastDay.getDate(); d++) {
    days.push(new Date(year, month, d));
  }
  // Trailing days to fill the grid (complete to multiple of 7)
  while (days.length % 7 !== 0) {
    const last = days[days.length - 1];
    days.push(new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1));
  }
  return days;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function ChatCalendarView({ onClose, onSelectEvent }: ChatCalendarViewProps) {
  const today = useMemo(() => new Date(), []);
  const [viewDate, setViewDate] = useState(
    () => new Date(today.getFullYear(), today.getMonth(), 1)
  );
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/app/chat/api/events');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error al cargar eventos');
      }
      const data = await res.json();
      setEvents(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const days = useMemo(() => getMonthGrid(viewDate.getFullYear(), viewDate.getMonth()), [viewDate]);

  // Map events by yyyy-mm-dd
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const d = new Date(event.startsAt);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const list = map.get(key) ?? [];
      list.push(event);
      map.set(key, list);
    }
    return map;
  }, [events]);

  const prevMonth = useCallback(() => {
    setViewDate((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
  }, []);

  const nextMonth = useCallback(() => {
    setViewDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
  }, []);

  const goToday = useCallback(() => {
    setViewDate(new Date(today.getFullYear(), today.getMonth(), 1));
  }, [today]);

  const handleEventClick = useCallback(
    (eventId: string) => {
      if (onSelectEvent) onSelectEvent(eventId);
    },
    [onSelectEvent]
  );

  return (
    <div className="chat-dialog-overlay" onClick={onClose}>
      <div className="chat-dialog chat-calendar-view" onClick={(e) => e.stopPropagation()}>
        <div className="chat-calendar-header">
          <h2>
            <CalendarIcon size={20} /> Calendario
          </h2>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>

        <div className="chat-calendar-nav">
          <button
            type="button"
            className="chat-calendar-nav-btn"
            onClick={prevMonth}
            aria-label="Mes anterior"
          >
            <ChevronLeft size={18} />
          </button>
          <span className="chat-calendar-month-label">
            {MONTH_NAMES[viewDate.getMonth()]} {viewDate.getFullYear()}
          </span>
          <button
            type="button"
            className="chat-calendar-nav-btn"
            onClick={nextMonth}
            aria-label="Mes siguiente"
          >
            <ChevronRight size={18} />
          </button>
          <button type="button" className="chat-calendar-nav-btn" onClick={goToday}>
            Hoy
          </button>
        </div>

        {loading && (
          <div className="chat-panel-loading">
            <Loader2 size={20} className="spin" /> Cargando eventos...
          </div>
        )}
        {error && <div className="chat-dialog-error">{error}</div>}

        {!loading && !error && (
          <>
            <div className="chat-calendar-weekdays">
              {WEEKDAYS.map((day) => (
                <div key={day} className="chat-calendar-weekday">
                  {day}
                </div>
              ))}
            </div>
            <div className="chat-calendar-grid">
              {days.map((day, index) => {
                const isOtherMonth = day.getMonth() !== viewDate.getMonth();
                const isToday = isSameDay(day, today);
                const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
                const dayEvents = eventsByDay.get(key) ?? [];

                return (
                  <div
                    key={index}
                    className={`chat-calendar-day ${isOtherMonth ? 'chat-calendar-day-other' : ''} ${isToday ? 'chat-calendar-today' : ''}`}
                  >
                    <span className="chat-calendar-day-number">{day.getDate()}</span>
                    <div className="chat-calendar-day-events">
                      {dayEvents.slice(0, 3).map((event) => (
                        <button
                          key={event.id}
                          type="button"
                          className="chat-calendar-event"
                          onClick={() => handleEventClick(event.id)}
                          title={event.title}
                        >
                          {event.title}
                        </button>
                      ))}
                      {dayEvents.length > 3 && (
                        <span className="chat-calendar-event-more">
                          +{dayEvents.length - 3} más
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
