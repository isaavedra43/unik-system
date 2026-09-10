'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/shadcn/dialog';
import { Button } from '@/components/shadcn/button';
import { cn } from '@/lib/utils';

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
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

function getMonthGrid(year: number, month: number): Date[] {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  let firstWeekday = firstDay.getDay() - 1;
  if (firstWeekday < 0) firstWeekday = 6;
  const days: Date[] = [];
  for (let i = 0; i < firstWeekday; i++) {
    days.push(new Date(year, month, -firstWeekday + i + 1));
  }
  for (let d = 1; d <= lastDay.getDate(); d++) {
    days.push(new Date(year, month, d));
  }
  while (days.length % 7 !== 0) {
    const last = days[days.length - 1];
    days.push(new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1));
  }
  return days;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function ChatCalendarView({ onClose, onSelectEvent }: ChatCalendarViewProps) {
  const today = useMemo(() => new Date(), []);
  const [viewDate, setViewDate] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
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

  const prevMonth = useCallback(() => setViewDate((p) => new Date(p.getFullYear(), p.getMonth() - 1, 1)), []);
  const nextMonth = useCallback(() => setViewDate((p) => new Date(p.getFullYear(), p.getMonth() + 1, 1)), []);
  const goToday = useCallback(() => setViewDate(new Date(today.getFullYear(), today.getMonth(), 1)), [today]);

  const handleEventClick = useCallback(
    (eventId: string) => {
      if (onSelectEvent) onSelectEvent(eventId);
    },
    [onSelectEvent]
  );

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarIcon size={18} /> Calendario
          </DialogTitle>
          <DialogDescription>Eventos de tus conversaciones</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <Button variant="outline" size="icon-sm" onClick={prevMonth} aria-label="Mes anterior">
            <ChevronLeft size={16} />
          </Button>
          <span className="text-sm font-semibold text-foreground">
            {MONTH_NAMES[viewDate.getMonth()]} {viewDate.getFullYear()}
          </span>
          <Button variant="outline" size="icon-sm" onClick={nextMonth} aria-label="Mes siguiente">
            <ChevronRight size={16} />
          </Button>
          <Button variant="ghost" size="sm" onClick={goToday}>Hoy</Button>
        </div>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 size={20} className="animate-spin" /> Cargando eventos...
          </div>
        )}
        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
        )}

        {!loading && !error && (
          <>
            <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-muted-foreground">
              {WEEKDAYS.map((day) => (
                <div key={day}>{day}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {days.map((day, index) => {
                const isOtherMonth = day.getMonth() !== viewDate.getMonth();
                const isToday = isSameDay(day, today);
                const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
                const dayEvents = eventsByDay.get(key) ?? [];
                return (
                  <div
                    key={index}
                    className={cn(
                      'flex flex-col gap-0.5 rounded-md p-1 min-h-[56px]',
                      isOtherMonth && 'opacity-40',
                      isToday && 'bg-primary/10 ring-1 ring-primary'
                    )}
                  >
                    <span className={cn('text-xs', isToday ? 'font-bold text-primary' : 'text-foreground')}>
                      {day.getDate()}
                    </span>
                    <div className="flex flex-col gap-0.5 overflow-hidden">
                      {dayEvents.slice(0, 2).map((event) => (
                        <button
                          key={event.id}
                          type="button"
                          className="truncate rounded bg-primary/15 px-1 text-left text-[10px] text-primary hover:bg-primary/25 transition-colors"
                          onClick={() => handleEventClick(event.id)}
                          title={event.title}
                        >
                          {event.title}
                        </button>
                      ))}
                      {dayEvents.length > 2 && (
                        <span className="text-[10px] text-muted-foreground">+{dayEvents.length - 2} más</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
