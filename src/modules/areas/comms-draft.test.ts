import { describe, expect, it } from 'vitest';
import {
  COMMS_DRAFT_TTL_MS,
  commsDraftKey,
  parseCommsDraft,
  serializeCommsDraft,
  stashCommsDraft,
  takeCommsDraft,
  type DraftStore,
} from './comms-draft';

/**
 * Traspaso del borrador entre el Radar de cierre y la bandeja externa del área.
 * Lo importante: el texto se consume UNA vez, caduca, y nunca sale de la
 * pestaña (por eso el almacén es inyectable y aquí se prueba sin navegador).
 */

function store(
  initial: Record<string, string> = {}
): DraftStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

const NOW = Date.parse('2026-09-15T18:00:00.000Z');

describe('borrador traspasado entre superficies del área', () => {
  it('guarda y consume el borrador una sola vez', () => {
    const memory = store();
    expect(
      stashCommsDraft('ventas', '  Hola, te comparto la cotización.  ', {
        now: NOW,
        origin: 'radar',
        store: memory,
      })
    ).toBe(true);
    expect(Object.keys(memory.data)).toStrictEqual([commsDraftKey('ventas')]);

    const taken = takeCommsDraft('ventas', { now: NOW + 1000, store: memory });
    expect(taken).toMatchObject({ text: 'Hola, te comparto la cotización.', origin: 'radar' });
    // Consumido: la segunda lectura ya no devuelve nada.
    expect(takeCommsDraft('ventas', { now: NOW + 2000, store: memory })).toBeNull();
    expect(memory.data).toStrictEqual({});
  });

  it('cada área tiene su propio borrador', () => {
    const memory = store();
    stashCommsDraft('ventas', 'Para el cliente', { now: NOW, store: memory });
    stashCommsDraft('compras', 'Para el proveedor', { now: NOW, store: memory });
    expect(takeCommsDraft('compras', { now: NOW, store: memory })?.text).toBe('Para el proveedor');
    expect(takeCommsDraft('ventas', { now: NOW, store: memory })?.text).toBe('Para el cliente');
  });

  it('no guarda un borrador vacío', () => {
    const memory = store();
    expect(stashCommsDraft('ventas', '   ', { now: NOW, store: memory })).toBe(false);
    expect(memory.data).toStrictEqual({});
    expect(serializeCommsDraft('', NOW)).toBeNull();
  });

  it('descarta un borrador vencido, roto o con fecha del futuro', () => {
    expect(parseCommsDraft(null, NOW)).toBeNull();
    expect(parseCommsDraft('{no es json', NOW)).toBeNull();
    expect(parseCommsDraft('[]', NOW)).toBeNull();
    expect(parseCommsDraft(JSON.stringify({ text: 'x' }), NOW)).toBeNull();
    const fresh = serializeCommsDraft('Sigo aquí', NOW)!;
    expect(parseCommsDraft(fresh, NOW + COMMS_DRAFT_TTL_MS - 1)?.text).toBe('Sigo aquí');
    expect(parseCommsDraft(fresh, NOW + COMMS_DRAFT_TTL_MS + 1)).toBeNull();
    // Un reloj adelantado no debe revivir un borrador ajeno.
    expect(parseCommsDraft(serializeCommsDraft('Del futuro', NOW + 600_000)!, NOW)).toBeNull();
  });

  it('sin almacén (servidor, modo privado) no rompe: guarda false y lee null', () => {
    expect(stashCommsDraft('ventas', 'Hola', { now: NOW, store: null })).toBe(false);
    expect(takeCommsDraft('ventas', { now: NOW, store: null })).toBeNull();
  });

  it('un almacén que lanza al escribir no tumba la pantalla', () => {
    const broken: DraftStore = {
      getItem: () => {
        throw new Error('bloqueado');
      },
      setItem: () => {
        throw new Error('bloqueado');
      },
      removeItem: () => {
        throw new Error('bloqueado');
      },
    };
    expect(stashCommsDraft('ventas', 'Hola', { now: NOW, store: broken })).toBe(false);
    expect(takeCommsDraft('ventas', { now: NOW, store: broken })).toBeNull();
  });
});
