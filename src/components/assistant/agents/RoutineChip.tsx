import React from 'react';
import { CalendarClock } from 'lucide-react';

/**
 * System line for a routine/vigil creation: "Rutina creada · Overnight
 * outbound". Renders only from real meta.routineCreated data.
 */
export function RoutineChip({ data }: { data: { name?: string; schedule?: string } }) {
  const schedule = data.schedule?.startsWith('daily:')
    ? `diario ${data.schedule.slice(6)}`
    : data.schedule?.startsWith('every:')
      ? `cada ${data.schedule.slice(6)} min`
      : data.schedule;
  if (!data.name && !schedule) return null;
  return (
    <div className="routine-chip" role="status">
      <CalendarClock size={13} />
      <span>
        Rutina creada{data.name ? ` · ${data.name}` : ''}
        {schedule ? ` · ${schedule}` : ''}
      </span>
    </div>
  );
}
