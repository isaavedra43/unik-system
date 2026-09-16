import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AREA_REGISTRY } from './area-registry';
import {
  AreaWorkQueryError,
  areaViewConfigSchema,
  areaWorkChipParams,
  areaWorkQueryFromSearchParams,
  tablePreferenceConfigSchema,
} from './work-filters';

/**
 * Saved views of an area's work centre.
 *
 * `createTableView` validates the config with whatever schema it is handed, and
 * its default is the sales orders one — whose `field` must be a sales-order
 * field. Saving an area view with an area filter used to throw a raw ZodError
 * at the person. These tests fix the contract: an area validates with ITS own
 * columns, refuses an unknown field in Spanish, and never stores the page.
 */

const presentation = tablePreferenceConfigSchema.parse({});

describe('areaViewConfigSchema', () => {
  it('acepta un filtro propio del área y conserva orden y chips', () => {
    const config = areaViewConfigSchema(AREA_REGISTRY.compras).parse({
      version: 1,
      query: {
        filters: {
          logic: 'AND',
          rules: [{ field: 'extra.vendorName', operator: 'contains', value: 'Acme' }],
        },
        sort: [{ field: 'dueAt', direction: 'desc' }],
        kind: ['procurement_order'],
        scope: 'open',
      },
      presentation,
    }) as { version: number; query: Record<string, unknown> };

    expect(config.version).toBe(1);
    expect(config.query.kind).toStrictEqual(['procurement_order']);
    expect(config.query.sort).toStrictEqual([{ field: 'dueAt', direction: 'desc' }]);
    expect((config.query.filters as { rules: unknown[] }).rules).toHaveLength(1);
  });

  it('no guarda la página: una vista abre siempre en la primera', () => {
    const config = areaViewConfigSchema(AREA_REGISTRY.ventas).parse({
      query: { page: 7, scope: 'all' },
      presentation,
    }) as { query: { page: number; scope: string } };

    expect(config.query.page).toBe(1);
    expect(config.query.scope).toBe('all');
  });

  it('rechaza en español un campo que esa área no puede filtrar', () => {
    // `extra.vendorName` es una columna de Compras: en Ventas no existe y no debe guardarse.
    const parse = () =>
      areaViewConfigSchema(AREA_REGISTRY.ventas).parse({
        query: {
          filters: {
            logic: 'AND',
            rules: [{ field: 'extra.vendorName', operator: 'contains', value: 'x' }],
          },
        },
        presentation,
      });
    expect(parse).toThrow(AreaWorkQueryError);
    expect(parse).toThrow(/No se puede filtrar por "extra.vendorName"/);
  });

  it('rechaza un tipo de fila que no es del área', () => {
    expect(() =>
      areaViewConfigSchema(AREA_REGISTRY.contabilidad).parse({
        query: { kind: ['production_order'] },
        presentation,
      })
    ).toThrow(/no tiene filas de tipo "production_order"/);
  });

  it('rechaza una presentación con forma inválida sin reventar con un error crudo', () => {
    expect(() =>
      areaViewConfigSchema(AREA_REGISTRY.logistica).parse({
        query: {},
        presentation: { density: 'enorme' },
      })
    ).toThrow(AreaWorkQueryError);
  });
});

/**
 * Enlaces de los chips de la barra del centro de trabajo.
 *
 * `areaWorkChipParams` es el ÚNICO lugar que escribe los nombres `kind`,
 * `scope`, `mios` y `vencidos`, y `areaWorkQueryFromSearchParams` (arriba, en
 * este mismo módulo) es el único que los lee. `chipHref` de
 * `area-workspace-model.ts` los deletreaba por su cuenta, así que las dos
 * mitades podían dejar de coincidir en silencio y el chip llevaba a una tabla
 * que ignoraba el filtro. Estas pruebas fijan la ida y la vuelta.
 */
const compras = AREA_REGISTRY.compras;
const asRawParams = (params: URLSearchParams) =>
  Object.fromEntries(params) as Record<string, string>;

describe('areaWorkChipParams', () => {
  const current = { kind: 'procurement_order', scope: 'all' as const, mine: true, overdue: false };

  it('el estado por omisión no ensucia la URL', () => {
    expect(
      areaWorkChipParams({ kind: null, scope: 'open', mine: false, overdue: false }, {}).toString()
    ).toBe('');
  });

  it('conserva el resto del estado al mover un solo eje', () => {
    const params = areaWorkChipParams(current, { overdue: true });
    expect(params.get('kind')).toBe('procurement_order');
    expect(params.get('scope')).toBe('all');
    expect(params.get('mios')).toBe('1');
    expect(params.get('vencidos')).toBe('1');
  });

  it('el chip «Todo» borra el tipo, y «all» tampoco viaja en la URL', () => {
    expect(areaWorkChipParams(current, { kind: null }).has('kind')).toBe(false);
    expect(areaWorkChipParams(current, { kind: 'all' }).has('kind')).toBe(false);
  });

  it('míos y vencidos se apagan igual que se encienden', () => {
    expect(areaWorkChipParams(current, { mine: false }).has('mios')).toBe(false);
    expect(
      areaWorkChipParams({ ...current, overdue: true }, { overdue: false }).has('vencidos')
    ).toBe(false);
  });

  it('la ida y la vuelta coinciden: lo que escribe un chip lo lee el centro de trabajo', () => {
    const params = areaWorkChipParams(
      { kind: null, scope: 'open', mine: false, overdue: false },
      { kind: 'rfq', scope: 'closed', mine: true, overdue: true }
    );
    const query = areaWorkQueryFromSearchParams(asRawParams(params), compras, { userId: 'u-1' });

    expect(query.kind).toStrictEqual(['rfq']);
    expect(query.scope).toBe('closed');
    expect(query.ownerUserId).toBe('u-1');
    expect(query.overdueOnly).toBe(true);
  });

  it('un enlace limpio devuelve el estado por omisión del área', () => {
    const params = areaWorkChipParams(
      { kind: 'rfq', scope: 'closed', mine: true, overdue: true },
      {
        kind: null,
        scope: 'open',
        mine: false,
        overdue: false,
      }
    );
    const query = areaWorkQueryFromSearchParams(asRawParams(params), compras, { userId: 'u-1' });

    expect(params.toString()).toBe('');
    expect(query.kind).toStrictEqual([]);
    expect(query.scope).toBe('open');
    expect(query.ownerUserId).toBeUndefined();
    expect(query.overdueOnly).toBe(false);
  });

  it('sólo ofrece tipos de fila que el área tiene: uno ajeno se rechaza al leerlo', () => {
    // El chip nunca lo escribiría, pero un enlace pegado a mano sí.
    const params = areaWorkChipParams({}, { kind: 'production_order' });
    expect(() => areaWorkQueryFromSearchParams(asRawParams(params), compras)).toThrow(
      /no tiene filas de tipo "production_order"/
    );
  });

  /**
   * La implementación vive en `area-links.ts` y no aquí a propósito: la barra de
   * chips es un componente de CLIENTE, y este módulo trae zod. Cuando el chip
   * importaba `work-filters.ts` para armar cuatro parámetros, zod entraba al
   * bundle de cliente de `/app/areas/[areaKey]/[space]`, ya la ruta más pesada
   * del repositorio. Nada impide volver a romperlo salvo esta prueba.
   */
  it('area-links sigue puro: no importa zod ni el valor de work-filters', () => {
    const source = readFileSync(new URL('./area-links.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+['"]zod['"]/);
    // Sólo se admite `import type` de work-filters: se borra al compilar.
    const workFiltersImports =
      source.match(/^import\s+(?:type\s+)?[\s\S]*?from\s+['"]\.\/work-filters['"]/gm) ?? [];
    for (const statement of workFiltersImports) {
      expect(statement).toMatch(/^import\s+type\s/);
    }
  });
});
