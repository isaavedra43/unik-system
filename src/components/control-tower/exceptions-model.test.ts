import { describe, expect, it } from 'vitest';
import {
  EXCEPTION_KINDS,
  EXCEPTION_KIND_LABELS,
  exceptionQuerySchema,
} from '@/modules/control-tower/exceptions-service';
import { CT_EXCEPTION_SORTABLE_FIELDS } from './exceptions-columns';
import {
  ctExceptionQueryStateSchema,
  CT_EXCEPTION_KINDS,
  CT_EXCEPTION_KIND_LABELS,
  CT_EXCEPTION_SEVERITIES,
  CtExceptionQueryError,
  EMPTY_CT_EXCEPTION_CHIPS,
  exceptionChipsFromParams,
  exceptionExtraUrlParams,
  exceptionKindChips,
  exceptionQueryFromSearchParams,
  exceptionSeverityChips,
  exceptionSeverityTone,
  parseCtExceptionQuery,
  queryFromChips,
  toExceptionServiceQuery,
} from './exceptions-model';

/**
 * The client-side mirror of the exception vocabulary must never drift from the
 * service's own constants: this suite is the only thing holding them together.
 */
describe('exceptions-model · espejo del servicio', () => {
  it('replica exactamente los tipos de excepción', () => {
    expect([...CT_EXCEPTION_KINDS]).toEqual([...EXCEPTION_KINDS]);
  });

  it('replica exactamente sus etiquetas', () => {
    for (const kind of EXCEPTION_KINDS) {
      expect(CT_EXCEPTION_KIND_LABELS[kind]).toBe(EXCEPTION_KIND_LABELS[kind]);
    }
  });

  it('usa las severidades que el esquema del servicio acepta', () => {
    const parsed = exceptionQuerySchema.parse({ severity: [...CT_EXCEPTION_SEVERITIES] });
    expect(parsed.severity).toEqual([...CT_EXCEPTION_SEVERITIES]);
  });

  it('sólo ordena por campos que el servicio conoce', () => {
    expect(CT_EXCEPTION_SORTABLE_FIELDS.length).toBeGreaterThan(0);
    for (const field of CT_EXCEPTION_SORTABLE_FIELDS) {
      expect(() => exceptionQuerySchema.parse({ sort: field })).not.toThrow();
    }
  });

  it('el esquema de estado de tabla es el que exporta el modelo', () => {
    expect(ctExceptionQueryStateSchema.parse({}).page).toBe(1);
  });
});

describe('exceptions-model · consulta', () => {
  it('rellena los valores por omisión', () => {
    const state = parseCtExceptionQuery({});
    expect(state.page).toBe(1);
    expect(state.page_size).toBe(50);
    expect(state.kind).toEqual([]);
    expect(state.sort).toEqual([]);
  });

  it('rechaza un orden desconocido en vez de ignorarlo', () => {
    expect(() =>
      parseCtExceptionQuery({ sort: [{ field: 'customerName', direction: 'asc' }] })
    ).toThrow(CtExceptionQueryError);
  });

  it('rechaza un filtro por un campo no filtrable', () => {
    expect(() =>
      parseCtExceptionQuery({
        filters: { logic: 'AND', rules: [{ field: 'title', operator: 'contains', value: 'x' }] },
      })
    ).toThrow(CtExceptionQueryError);
  });

  it('acepta el orden y los filtros de las columnas declaradas', () => {
    const state = parseCtExceptionQuery({
      sort: [{ field: 'dueAt', direction: 'asc' }],
      filters: { logic: 'AND', rules: [{ field: 'kind', operator: 'in', value: ['incident'] }] },
    });
    expect(state.sort[0].field).toBe('dueAt');
    expect(state.filters.rules).toHaveLength(1);
  });

  it('traduce el estado de la tabla a la entrada del servicio', () => {
    const query = toExceptionServiceQuery(
      parseCtExceptionQuery({
        search: '  ',
        page: 3,
        page_size: 25,
        sort: [{ field: 'since', direction: 'asc' }],
        kind: ['incident'],
        severity: ['high'],
        areaKey: ['ventas'],
      })
    );
    expect(query).toMatchObject({
      page: 3,
      page_size: 25,
      sort: 'since',
      direction: 'asc',
      kind: ['incident'],
      severity: ['high'],
      areaKey: ['ventas'],
    });
    // Lo que sale de aquí tiene que pasar el esquema del servicio.
    expect(() => exceptionQuerySchema.parse(query)).not.toThrow();
  });

  it('ordena por severidad descendente cuando nadie pidió orden', () => {
    const query = toExceptionServiceQuery(parseCtExceptionQuery({}));
    expect(query.sort).toBe('severity');
    expect(query.direction).toBe('desc');
  });

  it('intersecta los chips con el filtro en vez de ampliarlos', () => {
    const query = toExceptionServiceQuery(
      parseCtExceptionQuery({
        kind: ['incident', 'case_blocked'],
        filters: {
          logic: 'AND',
          rules: [{ field: 'kind', operator: 'in', value: ['incident', 'work_overdue'] }],
        },
      })
    );
    expect(query.kind).toEqual(['incident']);
  });

  it('descarta un valor de filtro que no es un tipo real', () => {
    const query = toExceptionServiceQuery(
      parseCtExceptionQuery({
        filters: {
          logic: 'AND',
          rules: [{ field: 'kind', operator: 'in', value: ['incident', 'inventado'] }],
        },
      })
    );
    expect(query.kind).toEqual(['incident']);
  });
});

describe('exceptions-model · chips', () => {
  it('lee el estado de la URL y descarta valores inventados', () => {
    expect(
      exceptionChipsFromParams({ tipo: 'incident', severidad: 'high', area: 'ventas' })
    ).toEqual({ kind: 'incident', severity: 'high', areaKey: 'ventas' });
    expect(exceptionChipsFromParams({ tipo: 'inventado', severidad: 'x' })).toEqual({
      kind: null,
      severity: null,
      areaKey: null,
    });
  });

  it('muestra "Todas" activo sin filtros y conserva el resto del estado al cambiar uno', () => {
    const chips = exceptionKindChips({ kind: null, severity: 'high', areaKey: null }, [
      { kind: 'incident', count: 3 },
    ]);
    expect(chips[0].active).toBe(true);
    const incident = chips.find((chip) => chip.id === 'incident');
    expect(incident?.label).toBe('Incidencia abierta (3)');
    expect(incident?.href).toContain('severidad=high');
    expect(incident?.href).toContain('tipo=incident');
  });

  it('oculta los tipos sin filas, salvo el que está seleccionado', () => {
    const chips = exceptionKindChips({ kind: 'case_stuck', severity: null, areaKey: null }, [
      { kind: 'incident', count: 2 },
    ]);
    expect(chips.map((chip) => chip.id)).toEqual(['all', 'incident', 'case_stuck']);
  });

  it('ofrece una severidad por opción más "Cualquiera"', () => {
    const chips = exceptionSeverityChips(EMPTY_CT_EXCEPTION_CHIPS);
    expect(chips).toHaveLength(CT_EXCEPTION_SEVERITIES.length + 1);
    expect(chips[0].active).toBe(true);
  });

  it('siembra la consulta desde los chips y los conserva en la URL', () => {
    const chips = { kind: 'incident' as const, severity: 'high' as const, areaKey: 'ventas' };
    expect(queryFromChips(chips)).toMatchObject({
      kind: ['incident'],
      severity: ['high'],
      areaKey: ['ventas'],
    });
    expect(exceptionExtraUrlParams(chips)).toEqual({
      tipo: 'incident',
      severidad: 'high',
      area: 'ventas',
    });
  });

  it('da un tono a cada severidad conocida', () => {
    expect(exceptionSeverityTone('critical')).toBe('danger');
    expect(exceptionSeverityTone('medium')).toBe('warning');
    expect(exceptionSeverityTone('desconocida')).toBe('default');
  });
});

describe('exceptions-model · enlace profundo', () => {
  it('recupera búsqueda, página, tamaño y orden de la URL', () => {
    const state = exceptionQueryFromSearchParams(
      {
        search: 'malla',
        page: '3',
        page_size: '25',
        sort: JSON.stringify([{ field: 'dueAt', direction: 'asc' }]),
      },
      { kind: 'incident', severity: null, areaKey: null }
    );
    expect(state).toMatchObject({ search: 'malla', page: 3, page_size: 25, kind: ['incident'] });
    expect(state.sort).toEqual([{ field: 'dueAt', direction: 'asc' }]);
  });

  it('recupera los filtros guardados en la URL', () => {
    const state = exceptionQueryFromSearchParams(
      {
        filters: JSON.stringify({
          logic: 'AND',
          rules: [{ field: 'severity', operator: 'in', value: ['critical'] }],
        }),
      },
      EMPTY_CT_EXCEPTION_CHIPS
    );
    expect(toExceptionServiceQuery(state).severity).toEqual(['critical']);
  });

  it('ignora un JSON roto en vez de romper la página', () => {
    const state = exceptionQueryFromSearchParams(
      { sort: '{esto no es json', filters: '[[' },
      EMPTY_CT_EXCEPTION_CHIPS
    );
    expect(state.sort).toEqual([]);
    expect(state.filters.rules).toEqual([]);
  });

  it('sigue rechazando un campo que no se puede ordenar, aunque venga de la URL', () => {
    expect(() =>
      exceptionQueryFromSearchParams(
        { sort: JSON.stringify([{ field: 'customerName', direction: 'asc' }]) },
        EMPTY_CT_EXCEPTION_CHIPS
      )
    ).toThrow(CtExceptionQueryError);
  });

  it('sin parámetros equivale a la consulta de los chips', () => {
    const chips = { kind: 'case_stuck' as const, severity: null, areaKey: null };
    expect(exceptionQueryFromSearchParams({}, chips)).toEqual(queryFromChips(chips));
  });
});
