import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  affectedCaseIdsSql,
  blockCauseCustomerSql,
  blockCauseProductSql,
  blockCauseQueries,
  blockCauseRouteSql,
  blockCauseVendorSql,
  blockCauseWaitReasonSql,
  caseActivationsSql,
  caseSequenceSql,
  handoffRequestsSql,
  handoffWorkItemsSql,
  maxEventIdSql,
  stepCompletionMetricsSql,
  stepReworkSql,
  stepStartedSql,
  stepWaitSql,
} from './projections-sql';

/**
 * SQL de las proyecciones. La regla del plan (sección 13) es tajante: TODO
 * valor viaja como parámetro y en este archivo NO se usa `Prisma.raw`, así que
 * no hay un solo identificador construido con texto de nadie.
 *
 * Estas pruebas leen el SQL ya armado (`Prisma.Sql`) y comprueban esa promesa,
 * además de la forma de cada consulta (de qué tabla sale el número).
 */

const WINDOW = {
  from: new Date('2026-09-01T00:00:00.000Z'),
  to: new Date('2026-09-16T00:00:00.000Z'),
};
const NOW = new Date('2026-09-15T18:00:00.000Z');
const WINDOW_FROM = new Date('2026-08-15T00:00:00.000Z');

/** Ninguna fecha ISO ni ningún id debe aparecer incrustado en el texto. */
function expectParameterized(sql: Prisma.Sql): void {
  expect(sql.text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  expect(sql.text).not.toMatch(/GMT|\+00:00/);
  for (const value of sql.values) {
    if (typeof value === 'string' && value.length > 3) {
      expect(sql.text).not.toContain(value);
    }
  }
}

const ALL: Array<[string, Prisma.Sql]> = [
  ['maxEventId', maxEventIdSql()],
  ['affectedCaseIds', affectedCaseIdsSql({ lastEventId: BigInt(10), since: NOW, limit: 500 })],
  ['caseSequence', caseSequenceSql(['c1', 'c2'])],
  ['caseActivations', caseActivationsSql(['c1'])],
  ['stepCompletionMetrics', stepCompletionMetricsSql(WINDOW)],
  ['stepStarted', stepStartedSql(WINDOW)],
  ['stepRework', stepReworkSql(WINDOW)],
  ['stepWait', stepWaitSql({ ...WINDOW, windowFrom: WINDOW_FROM })],
  ['handoffRequests', handoffRequestsSql(WINDOW)],
  ['handoffWorkItems', handoffWorkItemsSql(WINDOW)],
  [
    'blockCauseWaitReason',
    blockCauseWaitReasonSql({ ...WINDOW, windowFrom: WINDOW_FROM, now: NOW }),
  ],
  ['blockCauseVendor', blockCauseVendorSql({ ...WINDOW, now: NOW })],
  ['blockCauseProduct', blockCauseProductSql({ ...WINDOW, now: NOW })],
  ['blockCauseRoute', blockCauseRouteSql({ ...WINDOW, now: NOW })],
  ['blockCauseCustomer', blockCauseCustomerSql({ ...WINDOW, now: NOW })],
];

describe('parametrización', () => {
  it.each(ALL)('%s no pega valores en el texto del SQL', (_name, sql) => {
    expectParameterized(sql);
  });

  it('las fechas de la ventana viajan como parámetros, no como texto', () => {
    const sql = stepCompletionMetricsSql(WINDOW);
    expect(sql.values).toContain(WINDOW.from);
    expect(sql.values).toContain(WINDOW.to);
    expect(sql.text).toContain('$1');
  });

  it('las listas de ids se unen con parámetros, uno por id', () => {
    const sql = caseSequenceSql(["c1'; DROP TABLE users; --", 'c2']);
    expect(sql.text).not.toContain('DROP TABLE');
    expect(sql.values).toEqual(["c1'; DROP TABLE users; --", 'c2']);
  });

  it('la marca de agua y el tope también son parámetros', () => {
    const sql = affectedCaseIdsSql({ lastEventId: BigInt(77), since: NOW, limit: 123 });
    expect(sql.values).toEqual([BigInt(77), NOW, 123]);
  });
});

describe('forma de las consultas', () => {
  it('la secuencia sale de step.completed, ordenada por ocurrencia', () => {
    const sql = caseSequenceSql(['c1']);
    expect(sql.text).toContain(`'step.completed'`);
    expect(sql.text).toContain(`ORDER BY e."occurredAt", e."id"`);
    expect(sql.text).toContain(`array_agg`);
  });

  it('el retrabajo cuenta arranques y reaperturas por paso y alcance', () => {
    const sql = caseActivationsSql(['c1']);
    expect(sql.text).toContain(`'step.started'`);
    expect(sql.text).toContain(`'step.reopened'`);
    expect(sql.text).toContain(`'scopeKey'`);
  });

  it('los percentiles del paso usan percentile_cont sobre los minutos activos', () => {
    const sql = stepCompletionMetricsSql(WINDOW);
    expect(sql.text).toContain('percentile_cont(0.5)');
    expect(sql.text).toContain('percentile_cont(0.9)');
    expect(sql.text).toContain(`s."status" = 'done'`);
    expect(sql.text).toContain(`s."completedAt" > s."dueAt"`); // incumplimiento de SLA
  });

  it('la espera se mide con LEAD() desde step.waiting y se lee una ventana hacia atrás', () => {
    const sql = stepWaitSql({ ...WINDOW, windowFrom: WINDOW_FROM });
    expect(sql.text).toContain('LEAD(');
    expect(sql.text).toContain(`m."type" = 'step.waiting'`);
    expect(sql.values).toContain(WINDOW_FROM);
  });

  it('el traspaso por solicitud mide hasta el primer acuse o respuesta', () => {
    const sql = handoffRequestsSql(WINDOW);
    expect(sql.text).toContain('"AreaRequest" r');
    expect(sql.text).toContain(`'request.acknowledged'`);
    expect(sql.text).toContain('LIMIT 1');
    expect(sql.text).toContain(`r."status" = 'expired'`);
  });

  it('el traspaso por trabajo parte de workitem.reassigned', () => {
    const sql = handoffWorkItemsSql(WINDOW);
    expect(sql.text).toContain(`e."type" = 'workitem.reassigned'`);
    expect(sql.text).toContain(`'workitem.started'`);
  });

  it('las causas de proveedor y de ruta caminan por ObjectRelation vigente', () => {
    for (const sql of [
      blockCauseVendorSql({ ...WINDOW, now: NOW }),
      blockCauseRouteSql({ ...WINDOW, now: NOW }),
    ]) {
      expect(sql.text).toContain('"ObjectRelation"');
      expect(sql.text).toContain('"validTo" IS NULL');
    }
  });

  it('la causa por producto sólo cuenta solicitudes que bloquean la entrega', () => {
    const sql = blockCauseProductSql({ ...WINDOW, now: NOW });
    expect(sql.text).toContain(`r."blocksDelivery" = TRUE`);
  });

  it('el motivo de espera se normaliza y se recorta a 120 caracteres', () => {
    const sql = blockCauseWaitReasonSql({ ...WINDOW, windowFrom: WINDOW_FROM, now: NOW });
    expect(sql.text).toContain('LOWER(LEFT(');
    expect(sql.text).toContain('120');
    expect(sql.text).toContain(`'sin motivo'`);
  });

  it('blockCauseQueries devuelve las cinco consultas de causas', () => {
    const queries = blockCauseQueries({ ...WINDOW, windowFrom: WINDOW_FROM, now: NOW });
    expect(queries).toHaveLength(5);
    for (const sql of queries) expectParameterized(sql);
  });
});
