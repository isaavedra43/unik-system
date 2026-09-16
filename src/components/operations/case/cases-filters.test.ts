import { describe, expect, it } from 'vitest';
import {
  CASE_SCOPE_LABELS,
  CasesQueryError,
  caseAreaChips,
  caseChipsStateFromParams,
  caseExtraUrlParams,
  caseMineChip,
  casePhaseChips,
  caseRiskChips,
  caseScopeChips,
  caseViewConfigSchema,
  casesQueryFromSearchParams,
  parseCasesQuery,
  type CaseChipsState,
} from './cases-filters';

const USER = { userId: 'u-1' };

describe('consulta de expedientes', () => {
  it('aplica los valores por omisión', () => {
    expect(parseCasesQuery({})).toStrictEqual({
      filters: { logic: 'AND', rules: [] },
      sort: [],
      page: 1,
      page_size: 50,
      scope: 'open',
    });
  });

  it('acepta un filtro de texto y uno de estado con sus operadores', () => {
    const query = parseCasesQuery({
      filters: {
        logic: 'AND',
        rules: [
          { field: 'customerName', operator: 'contains', value: 'Norte' },
          { field: 'phase', operator: 'in', value: ['sourcing', 'delivering'] },
        ],
      },
      sort: [{ field: 'promisedAt', direction: 'asc' }],
    });
    expect(query.filters.rules).toHaveLength(2);
    expect(query.sort[0]).toStrictEqual({ field: 'promisedAt', direction: 'asc' });
  });

  it('rechaza un campo que no es columna filtrable', () => {
    expect(() =>
      parseCasesQuery({
        filters: {
          logic: 'AND',
          rules: [{ field: 'ownerUserId', operator: 'equals', value: 'u-1' }],
        },
      })
    ).toThrow(CasesQueryError);
    expect(() =>
      parseCasesQuery({
        filters: {
          logic: 'AND',
          rules: [{ field: 'version"; DROP TABLE', operator: 'contains', value: 'x' }],
        },
      })
    ).toThrow(/No se puede filtrar/);
  });

  it('rechaza un operador que no corresponde al tipo de la columna', () => {
    expect(() =>
      parseCasesQuery({
        filters: {
          logic: 'AND',
          rules: [{ field: 'phase', operator: 'contains', value: 'sourcing' }],
        },
      })
    ).toThrow(/no admite esa condición/);
    expect(() =>
      parseCasesQuery({
        filters: {
          logic: 'AND',
          rules: [{ field: 'promisedAt', operator: 'starts_with', value: '2026' }],
        },
      })
    ).toThrow(CasesQueryError);
  });

  it('rechaza ordenar por una columna calculada o desconocida', () => {
    expect(() => parseCasesQuery({ sort: [{ field: 'risk', direction: 'asc' }] })).toThrow(
      /No se puede ordenar/
    );
    expect(() =>
      parseCasesQuery({ sort: [{ field: 'blockingAreas', direction: 'desc' }] })
    ).toThrow(CasesQueryError);
  });

  it('rechaza un área desconocida y una fase inválida', () => {
    expect(() => parseCasesQuery({ areaKey: 'marketing' })).toThrow(/Área desconocida/);
    expect(() => parseCasesQuery({ phase: 'facturacion' })).toThrow(CasesQueryError);
  });

  it('acota el tamaño de página', () => {
    expect(() => parseCasesQuery({ page_size: 5000 })).toThrow(CasesQueryError);
    expect(parseCasesQuery({ page_size: '25' }).page_size).toBe(25);
  });
});

describe('consulta desde el enlace', () => {
  it('traduce los parámetros en español del enlace', () => {
    const query = casesQueryFromSearchParams(
      { fase: 'sourcing', riesgo: 'late', area: 'compras', mios: '1', scope: 'all' },
      USER
    );
    expect(query).toMatchObject({
      phase: 'sourcing',
      risk: 'late',
      areaKey: 'compras',
      ownerUserId: 'u-1',
      scope: 'all',
    });
  });

  it('ignora un ámbito inválido y no toma "míos" sin el valor 1', () => {
    const query = casesQueryFromSearchParams({ scope: 'borrados', mios: '0' }, USER);
    expect(query.scope).toBe('open');
    expect(query.ownerUserId).toBeUndefined();
  });

  it('un JSON de filtros roto se rechaza en lugar de ignorarse', () => {
    expect(() => casesQueryFromSearchParams({ filters: '{no-json' }, USER)).toThrow(
      CasesQueryError
    );
  });
});

describe('chips de la barra', () => {
  const base: CaseChipsState = {
    scope: 'open',
    phase: null,
    risk: null,
    areaKey: null,
    mine: false,
  };

  it('lee el estado del enlace y descarta valores desconocidos', () => {
    expect(
      caseChipsStateFromParams({
        scope: 'all',
        fase: 'nope',
        riesgo: 'ok',
        area: 'marketing',
        mios: '1',
      })
    ).toStrictEqual({ scope: 'all', phase: null, risk: null, areaKey: null, mine: true });
  });

  it('el ámbito abierto no ensucia la URL y los demás sí viajan', () => {
    expect(caseExtraUrlParams(base)).toStrictEqual({});
    expect(
      caseExtraUrlParams({ ...base, scope: 'closed', phase: 'closing', mine: true })
    ).toStrictEqual({ scope: 'closed', fase: 'closing', mios: '1' });
  });

  it('los chips de ámbito conservan el resto de los filtros', () => {
    const chips = caseScopeChips({ ...base, phase: 'sourcing' });
    expect(chips.map((chip) => chip.label)).toStrictEqual([
      CASE_SCOPE_LABELS.open,
      CASE_SCOPE_LABELS.closed,
      CASE_SCOPE_LABELS.all,
    ]);
    expect(chips[0].active).toBe(true);
    expect(chips[1].href).toBe('/app/operations?scope=closed&fase=sourcing');
  });

  it('los chips de fase y riesgo alternan contra "todas"', () => {
    const phases = casePhaseChips({ ...base, phase: 'delivering' });
    expect(phases[0]).toMatchObject({
      label: 'Todas las fases',
      href: '/app/operations',
      active: false,
    });
    expect(phases.find((chip) => chip.id === 'phase-delivering')?.active).toBe(true);

    const risks = caseRiskChips({ ...base, risk: 'late' });
    expect(risks.find((chip) => chip.id === 'risk-late')).toMatchObject({
      active: true,
      href: '/app/operations?riesgo=late',
    });
    expect(risks.every((chip) => chip.id === 'risk-all' || Boolean(chip.title))).toBe(true);
  });

  it('las áreas bloqueantes sólo aparecen cuando hay alguna', () => {
    expect(caseAreaChips(base, [])).toStrictEqual([]);
    const chips = caseAreaChips(base, ['compras', 'marketing']);
    expect(chips.map((chip) => chip.id)).toStrictEqual(['area-all', 'area-compras']);
    expect(chips[1].label).toBe('Compras');
  });

  it('el chip "Míos" alterna', () => {
    expect(caseMineChip(base).href).toBe('/app/operations?mios=1');
    expect(caseMineChip({ ...base, mine: true })).toMatchObject({
      active: true,
      href: '/app/operations',
    });
  });
});

describe('vista guardada de expedientes', () => {
  const presentation = {
    version: 1 as const,
    columnOrder: ['caseNumber', 'status'],
    columnVisibility: { caseNumber: true, status: true },
    columnWidths: { caseNumber: 140 },
    columnPinning: { left: [], right: [] },
    density: 'normal' as const,
    pageSize: 50,
  };

  it('guarda la consulta sin la página y conserva los filtros operativos', () => {
    const parsed = caseViewConfigSchema.parse({
      version: 1,
      query: {
        search: 'norte',
        filters: { logic: 'AND', rules: [{ field: 'status', operator: 'in', value: ['blocked'] }] },
        sort: [{ field: 'promisedAt', direction: 'asc' }],
        page_size: 25,
        scope: 'all',
        phase: 'sourcing',
        risk: 'late',
      },
      presentation,
    });
    expect('page' in parsed.query).toBe(false);
    expect(parsed.query.scope).toBe('all');
    expect(parsed.query.phase).toBe('sourcing');
    expect(parsed.query.risk).toBe('late');
    expect(parsed.query.filters.rules).toHaveLength(1);
    expect(parsed.presentation.pageSize).toBe(50);
  });

  it('una vista sin filtros es válida y trae los valores por omisión', () => {
    const parsed = caseViewConfigSchema.parse({ query: {}, presentation });
    expect(parsed.version).toBe(1);
    expect(parsed.query.scope).toBe('open');
    expect(parsed.query.filters).toStrictEqual({ logic: 'AND', rules: [] });
  });

  it('rechaza una vista cuyo estado de ámbito no existe', () => {
    expect(() =>
      caseViewConfigSchema.parse({ query: { scope: 'inventado' }, presentation })
    ).toThrow();
  });
});
