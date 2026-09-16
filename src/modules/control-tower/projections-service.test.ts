import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake, addRawHandler } = await import('@/modules/operations/testing/fixtures');
  const fake = createOpsFake({
    uniques: {
      ctCaseVariant: [['caseId']],
      ctStepMetricDaily: [['day', 'processKey', 'stepKey']],
      ctHandoffDaily: [['day', 'fromAreaKey', 'toAreaKey', 'kind']],
      ctBlockCauseDaily: [['day', 'causeType', 'causeKey']],
      ctProjectionWatermark: [['key']],
    },
  });
  return { fake, addRawHandler };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));

import {
  FULL_REBUILD_DAYS,
  PROJECTION_KEYS,
  getProjectionStatus,
  listCauses,
  listHandoffs,
  listStepMetrics,
  listVariants,
  projectionWindow,
  readWatermark,
  refreshProjections,
  refreshVariants,
  startOfUtcDay,
} from './projections-service';
import { variantHash } from './variants';
import { makeCurrentUser } from '@/modules/operations/testing/fixtures';

/**
 * Proyecciones de inteligencia de procesos con `FakePrisma`.
 *
 * Lo que se verifica:
 * - las consultas crudas viajan PARAMETRIZADAS (ninguna fecha ni id se pega en
 *   el texto del SQL);
 * - la variante de un expediente sale del blueprint que ESE expediente corrió;
 * - el recálculo es idempotente (correr dos veces deja una sola fila);
 * - una proyección que falla no detiene a las demás NI avanza su marca de agua,
 *   así que el siguiente tic la reintenta.
 */

const ADMIN = makeCurrentUser({ id: 'u-admin', permissionKeys: ['operations.admin'] });
const NOBODY = makeCurrentUser({ id: 'u-nadie', permissionKeys: [] });
const NOW = new Date('2026-09-15T18:00:00.000Z');

const DEFINITION = {
  processKey: 'sales_fulfillment',
  version: 1,
  steps: [
    { key: 'verificar', label: 'Verificar', dependsOn: [] },
    { key: 'plan', label: 'Plan', dependsOn: ['verificar'] },
    { key: 'entregar', label: 'Entregar', dependsOn: ['plan'] },
  ],
};

interface RecordedQuery {
  sql: string;
  values: unknown[];
}

let recorded: RecordedQuery[] = [];
let rawResults: Record<string, unknown[]> = {};
let failOn: RegExp | null = null;

/** Devuelve las filas preparadas para el primer patrón que case con el SQL. */
function answerFor(sql: string): unknown[] {
  for (const [pattern, rows] of Object.entries(rawResults)) {
    if (sql.includes(pattern)) return rows;
  }
  return [];
}

mocks.addRawHandler(mocks.fake, (query) => {
  recorded.push({ sql: query.sql, values: [...query.values] });
  if (failOn?.test(query.sql)) throw new Error('boom: la base se cayó a media consulta');
  return answerFor(query.sql);
});

function reset(): void {
  for (const table of mocks.fake.tables.keys()) mocks.fake.tables.set(table, []);
  recorded = [];
  rawResults = {};
  failOn = null;
}

function seedCase(id: string, over: Record<string, unknown> = {}, versionId = 'pv1'): void {
  mocks.fake.seed('operationalCase', {
    id,
    caseNumber: `EXP-${id}`,
    status: 'open',
    processVersionId: versionId,
    openedAt: new Date('2026-09-14T08:00:00.000Z'),
    closedAt: null,
    cancelledAt: null,
    customerName: 'Cliente',
    ...over,
  });
}

function seedVersion(id = 'pv1', definition: unknown = DEFINITION): void {
  mocks.fake.seed('processVersion', {
    id,
    processKey: 'sales_fulfillment',
    version: 1,
    definition,
    active: true,
  });
}

describe('projectionWindow', () => {
  it('una reconstrucción completa abarca la ventana larga', () => {
    const window = projectionWindow({ now: NOW, lastRunAt: null, full: true });
    const days = Math.round((window.to.getTime() - window.from.getTime()) / 86_400_000);
    expect(days).toBe(FULL_REBUILD_DAYS + 1);
  });

  it('sin marca de agua también reconstruye completo (primera corrida)', () => {
    const window = projectionWindow({ now: NOW, lastRunAt: null, full: false });
    expect(window.from.getTime()).toBeLessThan(startOfUtcDay(NOW).getTime());
  });

  it('la corrida incremental relee los días recientes, no sólo el de hoy', () => {
    const window = projectionWindow({
      now: NOW,
      lastRunAt: new Date('2026-09-15T17:45:00.000Z'),
      full: false,
    });
    expect(window.from.toISOString()).toBe('2026-09-13T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-09-16T00:00:00.000Z');
  });

  it('la ventana siempre es de al menos un día', () => {
    const window = projectionWindow({
      now: NOW,
      lastRunAt: new Date('2027-01-01T00:00:00.000Z'),
      full: false,
    });
    expect(window.to.getTime()).toBeGreaterThan(window.from.getTime());
  });
});

describe('refreshVariants', () => {
  beforeEach(reset);

  it('calcula secuencia, hash, conformidad y retrabajo del expediente', async () => {
    seedVersion();
    seedCase('c1', { closedAt: new Date('2026-09-15T08:00:00.000Z'), status: 'closed' });
    rawResults = {
      array_agg: [
        {
          caseId: 'c1',
          sequence: ['verificar', 'plan', 'entregar'],
          scopes: ['', '', ''],
          firstAt: new Date('2026-09-14T08:10:00.000Z'),
          lastAt: new Date('2026-09-15T07:50:00.000Z'),
        },
      ],
      "'step.started', 'step.reopened'": [
        { caseId: 'c1', stepKey: 'plan', scopeKey: '', activations: 3 },
        { caseId: 'c1', stepKey: 'verificar', scopeKey: '', activations: 1 },
      ],
    };

    const result = await refreshVariants({ caseIds: ['c1'] });
    expect(result).toEqual({ cases: 1, written: 1 });

    const [row] = mocks.fake.rows('ctCaseVariant');
    expect(row.caseId).toBe('c1');
    expect(row.processKey).toBe('sales_fulfillment');
    expect(row.processVersion).toBe(1);
    expect(row.variantHash).toBe(variantHash(['verificar', 'plan', 'entregar']));
    expect(row.sequence).toEqual(['verificar', 'plan', 'entregar']);
    expect(row.stepCount).toBe(3);
    expect(row.conformant).toBe(true);
    expect(row.reworkCount).toBe(2); // 3 activaciones de `plan` = 2 extra
    expect(row.durationMin).toBe(24 * 60); // 14/09 08:00 → 15/09 08:00
  });

  it('marca la desviación cuando un paso se completó antes que su dependencia', async () => {
    seedVersion();
    seedCase('c2');
    rawResults = {
      array_agg: [
        {
          caseId: 'c2',
          sequence: ['plan', 'verificar'],
          scopes: ['', ''],
          firstAt: null,
          lastAt: null,
        },
      ],
    };
    await refreshVariants({ caseIds: ['c2'] });
    const [row] = mocks.fake.rows('ctCaseVariant');
    expect(row.conformant).toBe(false);
    expect(row.violations[0]).toMatchObject({ kind: 'out_of_order', stepKey: 'plan' });
  });

  it('un expediente abierto no tiene duración', async () => {
    seedVersion();
    seedCase('c3');
    rawResults = {
      array_agg: [
        { caseId: 'c3', sequence: ['verificar'], scopes: [''], firstAt: null, lastAt: null },
      ],
    };
    await refreshVariants({ caseIds: ['c3'] });
    expect(mocks.fake.rows('ctCaseVariant')[0].durationMin).toBeNull();
  });

  it('sin pasos completados guarda la variante vacía en vez de saltarse el expediente', async () => {
    seedVersion();
    seedCase('c4');
    rawResults = {};
    await refreshVariants({ caseIds: ['c4'] });
    const [row] = mocks.fake.rows('ctCaseVariant');
    expect(row.sequence).toEqual([]);
    expect(row.stepCount).toBe(0);
    expect(row.variantHash).toBe(variantHash([]));
  });

  it('un blueprint corrupto no rompe la proyección: guarda la variante sin conformidad', async () => {
    seedVersion('pv-mala', { esto: 'no es un proceso' });
    seedCase('c5', {}, 'pv-mala');
    rawResults = {
      array_agg: [{ caseId: 'c5', sequence: ['x'], scopes: [''], firstAt: null, lastAt: null }],
    };
    await refreshVariants({ caseIds: ['c5'] });
    const [row] = mocks.fake.rows('ctCaseVariant');
    expect(row.processKey).toBe('sales_fulfillment');
    expect(row.conformant).toBe(true);
    expect(row.violations).toEqual([]);
  });

  it('es idempotente: dos corridas dejan UNA fila por expediente', async () => {
    seedVersion();
    seedCase('c6');
    rawResults = {
      array_agg: [
        { caseId: 'c6', sequence: ['verificar'], scopes: [''], firstAt: null, lastAt: null },
      ],
    };
    await refreshVariants({ caseIds: ['c6'] });
    await refreshVariants({ caseIds: ['c6', 'c6'] });
    expect(mocks.fake.rows('ctCaseVariant')).toHaveLength(1);
  });

  it('sin expedientes no consulta nada', async () => {
    const result = await refreshVariants({ caseIds: [] });
    expect(result).toEqual({ cases: 0, written: 0 });
    expect(recorded).toHaveLength(0);
  });

  it('los ids de los expedientes viajan como parámetros, no pegados al SQL', async () => {
    seedVersion();
    seedCase("c'; DROP TABLE users; --");
    rawResults = {};
    await refreshVariants({ caseIds: ["c'; DROP TABLE users; --"] });
    const sequenceQuery = recorded.find((query) => query.sql.includes('array_agg'));
    expect(sequenceQuery).toBeDefined();
    expect(sequenceQuery!.sql).not.toContain('DROP TABLE');
    expect(sequenceQuery!.values).toContain("c'; DROP TABLE users; --");
  });
});

describe('refreshProjections', () => {
  beforeEach(reset);

  it('corre las cuatro proyecciones y guarda una marca de agua por cada una', async () => {
    seedVersion();
    rawResults = { 'MAX("id")': [{ maxId: BigInt(4242) }] };

    const result = await refreshProjections({ now: NOW, full: false });
    expect(result.runs.map((run) => run.key)).toEqual([...PROJECTION_KEYS]);
    expect(result.failed).toBe(0);
    expect(result.runs.every((run) => run.ok)).toBe(true);

    const watermarks = mocks.fake.rows('ctProjectionWatermark');
    expect(watermarks).toHaveLength(PROJECTION_KEYS.length);
    for (const row of watermarks) {
      expect(row.lastEventId).toBe(BigInt(4242));
      expect(row.lastRunAt).toBeInstanceOf(Date);
      expect(typeof row.lastDurationMs).toBe('number');
    }
  });

  it('escribe las métricas por paso mezclando cierres, arranques, retrabajo y esperas', async () => {
    const day = new Date('2026-09-14T00:00:00.000Z');
    rawResults = {
      'MAX("id")': [{ maxId: BigInt(1) }],
      '"completed"': [
        {
          day,
          processKey: 'sales_fulfillment',
          stepKey: 'verificar',
          areaKey: 'inventario',
          completed: 12,
          p50ActiveMin: 31.456,
          p90ActiveMin: 90.1,
          avgActiveMin: 40,
          breached: 3,
        },
      ],
      '"started"': [
        {
          day,
          processKey: 'sales_fulfillment',
          stepKey: 'verificar',
          areaKey: 'inventario',
          started: 20,
        },
      ],
      "'step.reopened'": [
        { day, processKey: 'sales_fulfillment', stepKey: 'verificar', reworked: 2 },
      ],
      "'step.waiting'": [
        {
          day,
          processKey: 'sales_fulfillment',
          stepKey: 'verificar',
          p50WaitMin: 15,
          p90WaitMin: 240,
          waits: 5,
        },
      ],
    };

    await refreshProjections({ now: NOW, keys: ['step_metrics'] });
    const rows = mocks.fake.rows('ctStepMetricDaily');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      processKey: 'sales_fulfillment',
      stepKey: 'verificar',
      areaKey: 'inventario',
      started: 20,
      completed: 12,
      p50ActiveMin: 31.46,
      p90WaitMin: 240,
      breached: 3,
      reworked: 2,
    });
  });

  it('separa los traspasos por solicitud de los de reasignación de trabajo', async () => {
    const day = new Date('2026-09-14T00:00:00.000Z');
    const handoff = {
      day,
      fromAreaKey: 'ventas',
      toAreaKey: 'compras',
      count: 7,
      p50ResponseMin: 22,
      p90ResponseMin: 180,
      expired: 1,
    };
    rawResults = {
      'MAX("id")': [{ maxId: BigInt(1) }],
      '"AreaRequest" r': [handoff],
      "'workitem.reassigned'": [{ ...handoff, toAreaKey: 'ventas', count: 2, expired: 0 }],
    };

    await refreshProjections({ now: NOW, keys: ['handoffs'] });
    const rows = mocks.fake.rows('ctHandoffDaily');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.kind).sort()).toEqual(['request', 'workitem']);
    expect(rows.find((row) => row.kind === 'request')).toMatchObject({
      fromAreaKey: 'ventas',
      toAreaKey: 'compras',
      count: 7,
      expired: 1,
    });
  });

  it('suma las causas del mismo día y clave que vienen de consultas distintas', async () => {
    const day = new Date('2026-09-14T00:00:00.000Z');
    rawResults = {
      'MAX("id")': [{ maxId: BigInt(1) }],
      "'wait_reason'": [
        {
          day,
          causeType: 'wait_reason',
          causeKey: 'falta material',
          causeLabel: 'Falta material',
          blocks: 3,
          waitMin: 120.5,
        },
      ],
      "'vendor'": [
        {
          day,
          causeType: 'vendor',
          causeKey: 's1',
          causeLabel: 'Aceros SA',
          blocks: 1,
          waitMin: 60,
        },
      ],
    };
    await refreshProjections({ now: NOW, keys: ['block_causes'] });
    const rows = mocks.fake.rows('ctBlockCauseDaily');
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.causeType === 'wait_reason')).toMatchObject({
      causeKey: 'falta material',
      blocks: 3,
      waitMin: 120.5,
    });
  });

  it('una proyección que falla no detiene a las demás ni avanza su marca de agua', async () => {
    seedVersion();
    rawResults = { 'MAX("id")': [{ maxId: BigInt(99) }] };
    failOn = /step\.reopened/;

    const result = await refreshProjections({ now: NOW });
    const failing = result.runs.find((run) => run.key === 'step_metrics')!;
    expect(failing.ok).toBe(false);
    expect(failing.error).toContain('boom');
    expect(result.failed).toBe(1);
    expect(result.runs.filter((run) => run.ok)).toHaveLength(3);

    const keys = mocks.fake.rows('ctProjectionWatermark').map((row) => row.key);
    expect(keys).not.toContain('step_metrics');
    expect(keys).toContain('variants');
  });

  it('respeta el aborto del job: las proyecciones que faltan no se calculan', async () => {
    rawResults = { 'MAX("id")': [{ maxId: BigInt(1) }] };
    const controller = new AbortController();
    controller.abort();
    const result = await refreshProjections({ now: NOW, signal: controller.signal });
    expect(result.runs.every((run) => !run.ok)).toBe(true);
    expect(result.runs.every((run) => run.error === 'aborted')).toBe(true);
    expect(mocks.fake.rows('ctProjectionWatermark')).toHaveLength(0);
  });

  it('todas las consultas crudas llevan sus valores como parámetros', async () => {
    seedVersion();
    rawResults = { 'MAX("id")': [{ maxId: BigInt(1) }] };
    await refreshProjections({ now: NOW });
    const dated = recorded.filter((query) => query.values.some((value) => value instanceof Date));
    expect(dated.length).toBeGreaterThan(0);
    for (const query of recorded) {
      // Ninguna fecha ISO quedó incrustada en el texto del SQL.
      expect(query.sql).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    }
  });

  it('la reconstrucción completa exige operations.admin', async () => {
    const { rebuildProjections } = await import('./projections-service');
    await expect(rebuildProjections(NOBODY)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('readWatermark', () => {
  beforeEach(reset);

  it('devuelve cero cuando la proyección nunca corrió', async () => {
    const watermark = await readWatermark('variants');
    expect(watermark.lastEventId).toBe(BigInt(0));
    expect(watermark.lastRunAt).toBeNull();
  });
});

describe('lecturas', () => {
  beforeEach(reset);

  it('listVariants agrupa por hash y saca los expedientes desviados', async () => {
    seedVersion();
    seedCase('c1', { openedAt: new Date('2026-09-15T08:00:00.000Z') });
    seedCase('c2', { openedAt: new Date('2026-09-15T09:00:00.000Z') });
    mocks.fake.seed('ctCaseVariant', {
      caseId: 'c1',
      processKey: 'sales_fulfillment',
      processVersion: 1,
      variantHash: 'h1',
      sequence: ['verificar', 'plan'],
      stepCount: 2,
      durationMin: 100,
      conformant: true,
      violations: [],
      reworkCount: 0,
    });
    mocks.fake.seed('ctCaseVariant', {
      caseId: 'c2',
      processKey: 'sales_fulfillment',
      processVersion: 1,
      variantHash: 'h1',
      sequence: ['verificar', 'plan'],
      stepCount: 2,
      durationMin: 300,
      conformant: false,
      violations: [{ kind: 'out_of_order', stepKey: 'plan', detail: 'fuera de orden' }],
      reworkCount: 1,
    });

    const view = await listVariants(
      ADMIN,
      { from: new Date('2026-09-01T00:00:00.000Z') },
      { now: NOW }
    );
    expect(view.cases).toBe(2);
    expect(view.variants).toHaveLength(1);
    expect(view.variants[0].cases).toBe(2);
    expect(view.variants[0].label).toBe('Verificar → Plan'); // etiquetas del blueprint
    expect(view.conformantPct).toBe(50);
    expect(view.reworkPct).toBe(50);
    expect(view.nonConformant).toHaveLength(1);
    expect(view.nonConformant[0]).toMatchObject({ caseId: 'c2', caseNumber: 'EXP-c2' });
  });

  it('listVariants sin expedientes responde vacío sin dividir entre cero', async () => {
    const view = await listVariants(ADMIN, {}, { now: NOW });
    expect(view).toMatchObject({ cases: 0, conformantPct: 0, reworkPct: 0, variants: [] });
  });

  it('listStepMetrics agrega los días y rankea los cuellos de botella', async () => {
    for (const day of ['2026-09-13', '2026-09-14']) {
      mocks.fake.seed('ctStepMetricDaily', {
        day: new Date(`${day}T00:00:00.000Z`),
        processKey: 'sales_fulfillment',
        stepKey: 'esperar_recepcion',
        areaKey: 'compras',
        started: 10,
        completed: 8,
        p50ActiveMin: 10,
        p90ActiveMin: 20,
        p50WaitMin: 100,
        p90WaitMin: 400,
        breached: 2,
        reworked: 1,
      });
    }
    const view = await listStepMetrics(
      ADMIN,
      { from: new Date('2026-09-01T00:00:00.000Z') },
      { now: NOW }
    );
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0].started).toBe(20);
    expect(view.steps[0].breached).toBe(4);
    expect(view.daily).toHaveLength(2);
    expect(view.bottlenecks[0].stepKey).toBe('esperar_recepcion');
    expect(view.bottlenecks[0].impactMin).toBe(8_000);
  });

  it('listHandoffs arma la matriz área × área', async () => {
    mocks.fake.seed('ctHandoffDaily', {
      day: new Date('2026-09-14T00:00:00.000Z'),
      fromAreaKey: 'ventas',
      toAreaKey: 'compras',
      kind: 'request',
      count: 5,
      p50ResponseMin: 30,
      p90ResponseMin: 200,
      expired: 2,
    });
    const view = await listHandoffs(
      ADMIN,
      { from: new Date('2026-09-01T00:00:00.000Z') },
      { now: NOW }
    );
    expect(view.total).toBe(5);
    expect(view.expired).toBe(2);
    expect(view.cells[0]).toMatchObject({
      fromAreaKey: 'ventas',
      fromLabel: 'Ventas',
      toAreaKey: 'compras',
      toLabel: 'Compras',
    });
    expect(view.areas.map((area) => area.key).sort()).toEqual(['compras', 'ventas']);
  });

  it('listCauses ordena por espera acumulada y calcula el promedio', async () => {
    mocks.fake.seed('ctBlockCauseDaily', {
      day: new Date('2026-09-14T00:00:00.000Z'),
      causeType: 'vendor',
      causeKey: 's1',
      causeLabel: 'Aceros SA',
      blocks: 4,
      waitMin: 400,
    });
    mocks.fake.seed('ctBlockCauseDaily', {
      day: new Date('2026-09-14T00:00:00.000Z'),
      causeType: 'wait_reason',
      causeKey: 'sin material',
      causeLabel: 'Sin material',
      blocks: 2,
      waitMin: 40,
    });
    const view = await listCauses(
      ADMIN,
      { from: new Date('2026-09-01T00:00:00.000Z') },
      { now: NOW }
    );
    expect(view.causes.map((row) => row.causeKey)).toEqual(['s1', 'sin material']);
    expect(view.causes[0]).toMatchObject({ avgWaitMin: 100, causeTypeLabel: 'Proveedor' });
    expect(view.byType[0].causeType).toBe('vendor');
  });

  it('getProjectionStatus marca como rancia la proyección que no ha corrido', async () => {
    mocks.fake.seed('ctProjectionWatermark', {
      key: 'variants',
      lastEventId: BigInt(1),
      lastRunAt: new Date(NOW.getTime() - 10 * 60_000),
      lastDurationMs: 120,
    });
    const status = await getProjectionStatus(ADMIN, { now: NOW });
    expect(status).toHaveLength(PROJECTION_KEYS.length);
    const variants = status.find((row) => row.key === 'variants')!;
    expect(variants.minutesAgo).toBe(10);
    expect(variants.stale).toBe(false);
    expect(status.find((row) => row.key === 'handoffs')!.stale).toBe(true);
  });

  it('todas las lecturas exigen operations.admin', async () => {
    await expect(listVariants(NOBODY)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(listStepMetrics(NOBODY)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(listHandoffs(NOBODY)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(listCauses(NOBODY)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getProjectionStatus(NOBODY)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
