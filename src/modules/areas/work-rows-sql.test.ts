import { describe, expect, it } from 'vitest';
import { AREA_REGISTRY } from './area-registry';
import { AreaWorkQueryError, parseAreaWorkQuery, type AreaWorkQueryState } from './work-filters';
import {
  AREA_WORK_ROW_COLUMNS,
  buildAreaWorkRowsSql,
  commonWorkRowBranches,
  dateShortcutRange,
  escapeLike,
} from './work-rows-sql';

/**
 * The SQL of the work rows is built with `Prisma.sql`: every value written by a
 * person must travel as a bound parameter and only the columns of the area's
 * own registry may reach the query text.
 */

const AREA = AREA_REGISTRY.compras;
const NOW = new Date('2026-09-15T18:00:00.000Z');

function query(overrides: Partial<AreaWorkQueryState> = {}): AreaWorkQueryState {
  return parseAreaWorkQuery(
    {
      search: '',
      filters: { logic: 'AND', rules: [] },
      sort: [{ field: 'dueAt', direction: 'asc' }],
      page: 1,
      page_size: 50,
      kind: [],
      scope: 'open',
      ...overrides,
    },
    AREA
  );
}

function build(overrides: Partial<AreaWorkQueryState> = {}) {
  return buildAreaWorkRowsSql({
    area: AREA,
    branches: commonWorkRowBranches(),
    query: query(overrides),
    now: NOW,
  });
}

describe('ramas comunes', () => {
  it('cada área tiene trabajos y solicitudes en ambos sentidos', () => {
    expect(commonWorkRowBranches().map((branch) => branch.rowKind)).toStrictEqual([
      'work_item',
      'request_in',
      'request_out',
    ]);
  });

  it('todas las ramas proyectan las mismas columnas en el mismo orden', () => {
    const filters = { areaKey: 'compras', scope: 'all' as const, now: NOW };
    for (const branch of commonWorkRowBranches()) {
      const text = branch.sql(filters).text;
      const aliases = [...text.matchAll(/AS "([A-Za-z]+)"/g)].map((match) => match[1]);
      expect(aliases).toStrictEqual([...AREA_WORK_ROW_COLUMNS]);
    }
  });

  it('filtra por el área con un parámetro, nunca por interpolación', () => {
    const sql = commonWorkRowBranches()[0].sql({ areaKey: 'compras', scope: 'open', now: NOW });
    expect(sql.text).toContain('FROM "WorkItem"');
    expect(sql.text).not.toContain('compras');
    expect(sql.values).toContain('compras');
  });

  it('las solicitudes enviadas excluyen las que el área se manda a sí misma', () => {
    const branch = commonWorkRowBranches().find((entry) => entry.rowKind === 'request_out');
    const text = branch?.sql({ areaKey: 'compras', scope: 'all', now: NOW }).text ?? '';
    expect(text).toContain('"fromAreaKey" =');
    expect(text).toContain('"toAreaKey" <>');
  });

  it('el alcance abierto/cerrado se resuelve con los estados del núcleo', () => {
    const open = commonWorkRowBranches()[0].sql({ areaKey: 'compras', scope: 'open', now: NOW });
    const closed = commonWorkRowBranches()[0].sql({
      areaKey: 'compras',
      scope: 'closed',
      now: NOW,
    });
    expect(open.values).toContain('in_progress');
    expect(closed.text).toContain('AND NOT (');
  });
});

describe('consulta completa', () => {
  it('une las ramas y pagina', () => {
    const { rows, count } = build({ page: 3, page_size: 25 });
    expect(rows.text).toContain('UNION ALL');
    expect(rows.text).toContain('LIMIT');
    expect(rows.text).toContain('OFFSET');
    expect(rows.values).toContain(25);
    expect(rows.values).toContain(50); // (3 - 1) * 25
    expect(count.text).toContain('count(*)');
    expect(count.text).not.toContain('LIMIT');
  });

  it('ordena sólo por columnas conocidas y siempre con desempate estable', () => {
    const { rows } = build({ sort: [{ field: 'lastActivityAt', direction: 'desc' }] });
    expect(rows.text).toContain('"lastActivityAt"');
    expect(rows.text).toContain('DESC NULLS LAST');
    expect(rows.text).toContain('rows."rowKind" ASC, rows."sourceId" ASC');
  });

  it('rechaza ordenar o filtrar por una columna que el área no tiene', () => {
    expect(() => build({ sort: [{ field: 'salario', direction: 'asc' }] })).toThrow(
      AreaWorkQueryError
    );
    expect(() =>
      build({
        filters: { logic: 'AND', rules: [{ field: 'password', operator: 'contains', value: 'x' }] },
      })
    ).toThrow(AreaWorkQueryError);
  });

  it('el texto de búsqueda viaja como parámetro y nunca como SQL', () => {
    const malicious = `'; DROP TABLE "WorkItem"; --`;
    const { rows } = build({ search: malicious });
    expect(rows.text).not.toContain('DROP TABLE');
    expect(rows.values).toContain(`%${malicious}%`);
    expect(rows.text).toContain('ILIKE');
  });

  it('escapa los comodines que escribe una persona', () => {
    const { rows } = build({ search: '100% algodón_azul' });
    expect(rows.values).toContain('%100\\% algodón\\_azul%');
    expect(escapeLike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('filtra por una columna extra del área leyendo el JSON con la llave como parámetro', () => {
    const { rows } = build({
      filters: {
        logic: 'AND',
        rules: [{ field: 'extra.vendorName', operator: 'contains', value: 'Aceros' }],
      },
    });
    expect(rows.text).toContain('"extra" ->>');
    expect(rows.values).toContain('vendorName');
    expect(rows.values).toContain('%Aceros%');
    expect(rows.text).not.toContain('vendorName');
  });

  it('aplica los operadores de fecha y número con parámetros', () => {
    const { rows } = build({
      filters: {
        logic: 'AND',
        rules: [
          { field: 'dueAt', operator: 'before', value: '2026-09-20' },
          { field: 'amount', operator: 'between', value: 100, valueTo: 500 },
        ],
      },
    });
    expect(rows.text).toContain('::timestamptz');
    expect(rows.text).toContain('::numeric');
    expect(rows.values).toContain(100);
    expect(rows.values).toContain(500);
  });

  it('respeta la lógica OR del grupo de filtros', () => {
    const { rows } = build({
      filters: {
        logic: 'OR',
        rules: [
          { field: 'status', operator: 'equals', value: 'open' },
          { field: 'status', operator: 'equals', value: 'waiting' },
        ],
      },
    });
    expect(rows.text).toContain(' OR ');
  });

  it('descarta reglas sin valor utilizable en vez de romper la consulta', () => {
    const { rows } = build({
      filters: { logic: 'AND', rules: [{ field: 'amount', operator: 'equals', value: 'abc' }] },
    });
    expect(rows.text).toContain('UNION ALL');
    expect(rows.values).not.toContain('abc');
  });

  it('filtra por tipo de fila incluyendo sólo las ramas pedidas', () => {
    const { rows } = build({ kind: ['request_in'] });
    expect(rows.text).toContain('FROM "AreaRequest"');
    expect(rows.text).not.toContain('FROM "WorkItem"');
    expect(rows.values).toContain('request_in');
  });

  it('un tipo declarado sin rama todavía devuelve una consulta vacía y válida', () => {
    const { rows, count } = build({ kind: ['procurement_order'] });
    expect(rows.text).toContain('WHERE FALSE');
    expect(count.text).toContain('0::int');
  });

  it('filtra por expediente, por persona y por vencidos', () => {
    const { rows } = build({
      caseId: 'case-1',
      ownerUserId: 'u-1',
      overdueOnly: true,
    });
    expect(rows.values).toContain('case-1');
    expect(rows.values).toContain('u-1');
    expect(rows.text).toContain(`"extra" ->> 'backupUserId'`);
    expect(rows.values).toContain(NOW);
  });

  it('el alcance cerrado invierte la condición de abierto', () => {
    expect(build({ scope: 'closed' }).rows.text).toContain('rows."open" = FALSE');
    expect(build({ scope: 'all' }).rows.text).not.toContain('rows."open" =');
  });
});

describe('atajos de fecha', () => {
  it('resuelve los rangos relativos al servidor', () => {
    const today = dateShortcutRange('today', NOW);
    expect(today?.from.getHours()).toBe(0);
    expect(today?.to.getHours()).toBe(23);
    expect(dateShortcutRange('last_7_days', NOW)?.from.getTime()).toBeLessThan(NOW.getTime());
    expect(dateShortcutRange('inexistente', NOW)).toBeNull();
  });

  it('un atajo manda sobre el operador', () => {
    const { rows } = build({
      filters: {
        logic: 'AND',
        rules: [{ field: 'dueAt', operator: 'equals', shortcut: 'today' }],
      },
    });
    const dates = rows.values.filter((value): value is Date => value instanceof Date);
    expect(dates.length).toBeGreaterThanOrEqual(2);
  });
});
