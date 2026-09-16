import { describe, expect, it } from 'vitest';
import { AREA_REGISTRY } from '../area-registry';
import { AREA_WORK_ROW_COLUMNS, type AreaWorkSqlFilters } from '../work-rows-sql';
import { deliveryOrderBranch, logisticsWorkRowBranches, tripBranch } from './work-rows';

/**
 * The branches of Logística are built with `Prisma.sql`: the only literals in
 * the query text are column names and the labels of this module, and every
 * value (the area, the case, the person) travels as a bound parameter.
 */

const NOW = new Date('2026-09-15T18:00:00.000Z');

function filters(overrides: Partial<AreaWorkSqlFilters> = {}): AreaWorkSqlFilters {
  return { areaKey: 'logistica', scope: 'open', now: NOW, ...overrides };
}

/** Aliases of the SELECT list (the lateral subquery aliases come later in the text). */
function canonicalAliases(text: string): string[] {
  return [...text.matchAll(/AS "([A-Za-z]+)"/g)]
    .map((match) => match[1])
    .slice(0, AREA_WORK_ROW_COLUMNS.length);
}

describe('ramas de Logística', () => {
  it('declara los tipos de fila que el registro del área conoce', () => {
    const kinds = logisticsWorkRowBranches().map((branch) => branch.rowKind);
    expect(kinds).toStrictEqual(['delivery_order', 'trip']);
    for (const kind of kinds) {
      expect(AREA_REGISTRY.logistica.workCenter.rowKinds).toContain(kind);
    }
  });

  it('ambas ramas proyectan las columnas canónicas en el mismo orden', () => {
    for (const branch of logisticsWorkRowBranches()) {
      expect(canonicalAliases(branch.sql(filters({ scope: 'all' })).text)).toStrictEqual([
        ...AREA_WORK_ROW_COLUMNS,
      ]);
    }
  });

  it('el tipo de fila y el área viajan como parámetros', () => {
    const sql = deliveryOrderBranch().sql(filters());
    expect(sql.text).toContain('FROM "DeliveryOrder"');
    expect(sql.values).toContain('delivery_order');
    expect(sql.values).toContain('logistica');
  });

  it('filtra por expediente y por persona con parámetros, nunca interpolando', () => {
    const sql = deliveryOrderBranch().sql(
      filters({ caseId: 'case-1\'; DROP TABLE "Trip"; --', ownerUserId: 'u-7' })
    );
    expect(sql.text).not.toContain('DROP TABLE');
    expect(sql.text).toContain('d."caseId" =');
    expect(sql.text).toContain('dr."userId" =');
    expect(sql.values).toContain('case-1\'; DROP TABLE "Trip"; --');
    expect(sql.values).toContain('u-7');
  });

  it('un viaje no pertenece a un expediente: filtrar por caso lo deja fuera', () => {
    const sql = tripBranch().sql(filters({ caseId: 'case-1' }));
    expect(sql.text).toContain('AND FALSE');
  });

  it('el alcance abierto usa los estados abiertos de cada objeto', () => {
    const open = deliveryOrderBranch().sql(filters({ scope: 'open' }));
    expect(open.values).toContain('pending_external');
    expect(open.values).toContain('conflict');
    const closed = deliveryOrderBranch().sql(filters({ scope: 'closed' }));
    expect(closed.text).toContain('AND NOT (');
    const trips = tripBranch().sql(filters({ scope: 'open' }));
    expect(trips.values).toContain('en_route');
  });

  it('las etiquetas de estado y de modo viajan como valores, no como texto SQL', () => {
    const sql = deliveryOrderBranch().sql(filters());
    expect(sql.values).toContain('Esperando a Zoho');
    expect(sql.values).toContain('Flotilla propia');
    expect(sql.text).not.toContain('Esperando a Zoho');
  });

  it('la entrega expone las columnas extra del área y su sincronización con Zoho', () => {
    const text = deliveryOrderBranch().sql(filters()).text;
    expect(text).toContain("'carrier'");
    expect(text).toContain("'plannedDate'");
    expect(text).toContain("'zohoSyncState'");
    expect(text).toContain("'tripId'");
  });

  it('el viaje resume sus paradas y ofrece comandos que el diálogo compartido sabe enviar', () => {
    const sql = tripBranch().sql(filters());
    expect(sql.text).toContain('LEFT JOIN LATERAL');
    expect(sql.text).toContain("'stopsPending'");
    const actions = sql.values.filter(
      (value): value is string => typeof value === 'string' && value.startsWith('[{')
    );
    expect(actions).toHaveLength(2);
    const parsed = actions.map((value) => JSON.parse(value) as Array<Record<string, unknown>>);
    // Plan §4: un viaje planeado se inicia o se cancela; uno en ruta se cierra
    // o se cancela. Cancelar está en los dos porque el viaje puede caerse antes
    // de salir o a media ruta.
    expect(parsed.flat().map((action) => action.commandType)).toStrictEqual([
      'trip.start',
      'trip.cancel',
      'trip.close',
      'trip.cancel',
    ]);
    for (const action of parsed.flat()) {
      // The shared dialog only sends note / reason / answer: a domain action
      // offered from the table must not need any other field.
      expect(['none', 'reason']).toContain(action.form);
      expect(action.aggregateType).toBe('trip');
      expect(action.permissions).toStrictEqual(['logistics.dispatch']);
    }
    const cancel = parsed.flat().filter((action) => action.commandType === 'trip.cancel');
    expect(cancel).toHaveLength(2);
    for (const action of cancel) {
      // El motivo viaja como `reason`, que es la clave que el comando espera.
      expect(action).toMatchObject({ id: 'trip.cancel', form: 'reason', tone: 'danger' });
      expect(action.payloadTextKey).toBeUndefined();
    }
  });

  it('las entregas no ofrecen acciones de tabla: sus comandos piden datos propios', () => {
    const text = deliveryOrderBranch().sql(filters()).text;
    expect(text).not.toContain("'actions'");
  });
});
