import type { BadgeVariant } from '@/components/ui/primitives';
import { formatTimelineLine } from '@/modules/agents/templates';
import type { PersonNow, PersonPresence } from '@/modules/control-tower/people-service';

/**
 * Pure rules of "quién está haciendo qué ahora" (plan 7.7 `personas`): tone of
 * a presence, tone of a workload, the client-side filter of the table and the
 * one-line description of the last thing a person did.
 *
 * The last event is rendered with `formatTimelineLine` (agents layer), the same
 * function the case timeline and the case rooms use, so the Control Tower never
 * invents its own wording for an operational fact.
 */

export const PRESENCE_ORDER: readonly PersonPresence[] = [
  'active',
  'idle',
  'inactive',
  'unassigned',
];

export const PRESENCE_TONES: Record<PersonPresence, BadgeVariant> = {
  active: 'success',
  idle: 'warning',
  inactive: 'weak',
  unassigned: 'weak',
};

export function presenceTone(presence: PersonPresence): BadgeVariant {
  return PRESENCE_TONES[presence] ?? 'weak';
}

/** Red when something is already late, amber when the person is loaded. */
export function loadTone(
  person: Pick<PersonNow, 'overdueWorkItems' | 'openWorkItems'>
): BadgeVariant {
  if (person.overdueWorkItems > 0) return 'danger';
  if (person.openWorkItems >= 8) return 'warning';
  if (person.openWorkItems === 0) return 'weak';
  return 'default';
}

/**
 * What the person did last, in Spanish, plus how long ago. Returns `null` when
 * there is no recorded activity, so the table can say "sin actividad" once
 * instead of printing an empty line.
 */
export function lastEventLine(person: PersonNow): string | null {
  if (!person.lastEventType || !person.lastEventAt) return null;
  const line = formatTimelineLine({
    type: person.lastEventType,
    occurredAt: person.lastEventAt,
    ...(person.areaKey ? { areaKey: person.areaKey } : {}),
  });
  // `formatTimelineLine` prefixes the clock ("09:29 Compras recibió…"); the
  // table already shows "hace N min", so the phrase alone is enough.
  const withoutClock = line.replace(/^\d{1,2}:\d{2}\s+/, '');
  return withoutClock || null;
}

export function elapsedLabel(minutes: number | null): string {
  if (minutes === null) return 'sin actividad registrada';
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

export interface PeopleFilterState {
  areaKey: string;
  presence: string;
  search: string;
}

export const EMPTY_PEOPLE_FILTERS: PeopleFilterState = {
  areaKey: '',
  presence: '',
  search: '',
};

/**
 * Client-side filter over the page the server already returned. It never asks
 * for more rows: the area filter of the API is the one that changes the query.
 */
export function filterPeople(
  people: readonly PersonNow[],
  filters: PeopleFilterState
): PersonNow[] {
  const term = filters.search.trim().toLocaleLowerCase('es');
  return people.filter((person) => {
    if (filters.areaKey && person.areaKey !== filters.areaKey) return false;
    if (filters.presence && person.presence !== filters.presence) return false;
    if (!term) return true;
    const haystack = [person.name, person.username, person.areaLabel, person.role, person.nextTitle]
      .filter((value): value is string => Boolean(value))
      .join(' ')
      .toLocaleLowerCase('es');
    return haystack.includes(term);
  });
}

/** Areas present in the page, for the area picker (never invents keys). */
export function peopleAreaOptions(
  people: readonly PersonNow[]
): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>();
  for (const person of people) {
    if (person.areaKey && person.areaLabel && !seen.has(person.areaKey)) {
      seen.set(person.areaKey, person.areaLabel);
    }
  }
  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'es'));
}
