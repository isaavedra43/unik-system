import { describe, expect, it } from 'vitest';
import type { PersonNow } from '@/modules/control-tower/people-service';
import {
  EMPTY_PEOPLE_FILTERS,
  PRESENCE_ORDER,
  elapsedLabel,
  filterPeople,
  lastEventLine,
  loadTone,
  peopleAreaOptions,
  presenceTone,
} from './people-model';

function person(overrides: Partial<PersonNow> = {}): PersonNow {
  return {
    userId: 'u1',
    name: 'Ana Ruiz',
    username: 'ana',
    areaKey: 'ventas',
    areaLabel: 'Ventas',
    role: 'Responsable',
    openWorkItems: 3,
    inProgressWorkItems: 1,
    overdueWorkItems: 0,
    waitingWorkItems: 0,
    openRequests: 0,
    nextTitle: 'Confirmar entrega',
    nextDueAt: '2026-09-15T18:00:00.000Z',
    lastEventType: 'request.acknowledged',
    lastEventAt: '2026-09-15T12:00:00.000Z',
    lastEventMinutesAgo: 5,
    lastEventCaseId: 'c1',
    presence: 'active',
    presenceLabel: 'Activo',
    ...overrides,
  };
}

describe('people-model · tonos', () => {
  it('da un tono a cada presencia declarada', () => {
    for (const presence of PRESENCE_ORDER) {
      expect(presenceTone(presence)).toBeTruthy();
    }
    expect(presenceTone('active')).toBe('success');
  });

  it('marca en rojo a quien tiene vencidos y en ámbar a quien va cargado', () => {
    expect(loadTone({ overdueWorkItems: 1, openWorkItems: 2 })).toBe('danger');
    expect(loadTone({ overdueWorkItems: 0, openWorkItems: 9 })).toBe('warning');
    expect(loadTone({ overdueWorkItems: 0, openWorkItems: 3 })).toBe('default');
    expect(loadTone({ overdueWorkItems: 0, openWorkItems: 0 })).toBe('weak');
  });
});

describe('people-model · último evento', () => {
  it('describe el evento en español y sin el reloj', () => {
    const line = lastEventLine(person());
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/^\d{1,2}:\d{2}/);
  });

  it('devuelve null cuando no hay actividad registrada', () => {
    expect(lastEventLine(person({ lastEventType: null, lastEventAt: null }))).toBeNull();
  });

  it('traduce los minutos a una frase corta', () => {
    expect(elapsedLabel(null)).toBe('sin actividad registrada');
    expect(elapsedLabel(0)).toBe('hace un momento');
    expect(elapsedLabel(42)).toBe('hace 42 min');
    expect(elapsedLabel(150)).toBe('hace 2 h');
    expect(elapsedLabel(60 * 26)).toBe('hace 1 d');
  });
});

describe('people-model · filtros', () => {
  const people = [
    person(),
    person({
      userId: 'u2',
      name: 'Beto Lara',
      username: 'beto',
      areaKey: 'compras',
      areaLabel: 'Compras',
      presence: 'idle',
      nextTitle: 'Cotizar tubería',
    }),
    person({
      userId: 'u3',
      name: 'Caro Díaz',
      username: 'caro',
      areaKey: null,
      areaLabel: null,
      presence: 'unassigned',
      nextTitle: null,
    }),
  ];

  it('sin filtros devuelve a todas', () => {
    expect(filterPeople(people, EMPTY_PEOPLE_FILTERS)).toHaveLength(3);
  });

  it('filtra por área y por presencia', () => {
    expect(filterPeople(people, { ...EMPTY_PEOPLE_FILTERS, areaKey: 'compras' })).toHaveLength(1);
    expect(filterPeople(people, { ...EMPTY_PEOPLE_FILTERS, presence: 'idle' })).toHaveLength(1);
  });

  it('busca sin acentos ni mayúsculas en nombre, usuario, área y pendiente', () => {
    expect(filterPeople(people, { ...EMPTY_PEOPLE_FILTERS, search: 'BETO' })).toHaveLength(1);
    expect(filterPeople(people, { ...EMPTY_PEOPLE_FILTERS, search: 'tubería' })).toHaveLength(1);
    expect(filterPeople(people, { ...EMPTY_PEOPLE_FILTERS, search: 'ventas' })).toHaveLength(1);
    expect(filterPeople(people, { ...EMPTY_PEOPLE_FILTERS, search: 'nadie' })).toHaveLength(0);
  });

  it('ofrece sólo las áreas presentes en la página, ordenadas', () => {
    expect(peopleAreaOptions(people)).toEqual([
      { value: 'compras', label: 'Compras' },
      { value: 'ventas', label: 'Ventas' },
    ]);
  });
});
