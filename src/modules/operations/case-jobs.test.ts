import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const fixtures = await import('./testing/case-fixtures');
  const inventory = await import('@/modules/inventory/testing/inventory-fixtures');
  const fake = fixtures.createCaseFake();
  return {
    fake,
    locks: inventory.createLockEmulation(fake),
    registerJobHandler: vi.fn(),
    registerRecurringJob: vi.fn(),
    notifyUser: vi.fn(async () => ({ id: 'n1', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async () => ({
      id: '1',
      channel: '',
      type: '',
      payload: {},
      createdAt: '',
    })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));
vi.mock('@/modules/inventory/inventory-locks', () => mocks.locks.module);
vi.mock('@/modules/jobs/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/jobs/job-queue')>()),
  registerJobHandler: mocks.registerJobHandler,
}));
vi.mock('@/modules/jobs/scheduled-jobs', () => ({
  registerRecurringJob: mocks.registerRecurringJob,
}));

import {
  reconcileOrdersWithoutCase,
  runCaseAdvanceJob,
  runCaseReplanJob,
  runCaseStartJob,
} from './case-jobs';
import { invalidateOperationsConfigCache } from './operations-config';
import { clearProcessBlueprintCache } from './process-blueprints/registry';
import { addRawHandler, RAW_NOT_HANDLED } from './testing/fixtures';
import {
  makeCaseJob,
  seedCaseTeam,
  seedItemStock,
  seedOperationsConfig,
  seedOrderItems,
  seedSalesOrder,
  type ReconcileRow,
} from './testing/case-fixtures';

const { fake } = mocks;
const registeredTypes = mocks.registerJobHandler.mock.calls.map((call) => call[0]);
const recurring = [...mocks.registerRecurringJob.mock.calls];

let reconcileRows: ReconcileRow[] = [];
const rawQueries: Array<{ sql: string; values: unknown[] }> = [];
addRawHandler(fake, (query) => {
  if (!/FROM "SalesOrder" so/.test(query.sql)) return RAW_NOT_HANDLED;
  rawQueries.push({ sql: query.sql, values: query.values });
  return reconcileRows;
});

beforeEach(() => {
  fake.tables.clear();
  mocks.locks.reset();
  invalidateOperationsConfigCache();
  clearProcessBlueprintCache();
  reconcileRows = [];
  rawQueries.length = 0;
  seedCaseTeam(fake);
  seedOperationsConfig(fake);
});

describe('registro', () => {
  it('registra los tres handlers, el reconciliador y su recurrencia de 5 minutos', () => {
    expect(registeredTypes).toEqual([
      'ops.case.start',
      'ops.case.replan',
      'ops.case.advance',
      'ops.case.reconcile_orders',
    ]);
    expect(recurring).toEqual([
      [{ type: 'ops.case.reconcile_orders', everyMs: 300_000, priority: 300 }],
    ]);
  });
});

describe('ops.case.start', () => {
  it('ejecuta case.start como sistema; repetir el intento devuelve el resultado guardado', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 25 });
    seedSalesOrder(fake, { lines: [{ quantity: 10 }] });
    const job = makeCaseJob({ zohoSalesOrderId: 'zso-1' }, { id: 'job_a', attempt: 1 });

    const first = await runCaseStartJob(job);
    const again = await runCaseStartJob(job);

    expect(first).toMatchObject({
      commandId: 'ops:case.start:so:zso-1:job_a:1',
      status: 'completed',
      data: { created: true, caseNumber: 'EXP-000001' },
    });
    expect(again).toMatchObject({ status: 'completed', replayed: true });
    expect(fake.rows('operationalCase')).toHaveLength(1);
    expect(fake.rows('operationalCommand')[0]).toMatchObject({
      actorType: 'system',
      actorId: 'job:ops.case.start',
    });
  });

  it('un rechazo de negocio completa el job (no reintenta) y un payload inválido se omite', async () => {
    seedSalesOrder(fake, { status: 'draft', lines: [{ quantity: 1 }] });
    await expect(
      runCaseStartJob(makeCaseJob({ zohoSalesOrderId: 'zso-1' }))
    ).resolves.toMatchObject({
      status: 'rejected',
      errorCode: 'case_not_eligible',
    });
    await expect(runCaseStartJob(makeCaseJob({ nope: true }))).resolves.toEqual({
      skipped: 'invalid_payload',
    });
  });
});

describe('ops.case.replan y ops.case.advance', () => {
  it('replanea con el id del cambio y resuelve el expediente por la orden', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 25 });
    const { order } = seedSalesOrder(fake, { lines: [{ quantity: 10 }] });
    await runCaseStartJob(makeCaseJob({ zohoSalesOrderId: 'zso-1' }));
    seedOrderItems(fake, order.id as string, [{ quantity: 4 }]);

    const result = await runCaseReplanJob(
      makeCaseJob(
        { zohoSalesOrderId: 'zso-1', changeEventId: 'chg-9' },
        { id: 'job_r', attempt: 2 }
      )
    );

    const caseId = fake.rows('operationalCase')[0].id;
    expect(result).toMatchObject({
      commandId: `ops:case.replan:${caseId}:chg-9:2`,
      status: 'completed',
      data: { changed: true, changeEventId: 'chg-9' },
    });
    expect(String(fake.rows('caseDemand')[0].quantity)).toBe('4');
    await expect(
      runCaseReplanJob(makeCaseJob({ zohoSalesOrderId: 'zso-x', changeEventId: 'chg-1' }))
    ).resolves.toMatchObject({ skipped: 'case_missing' });
  });

  it('avanza el expediente como sistema', async () => {
    seedItemStock(fake, { zohoItemId: 'item-1', quantity: 25 });
    seedSalesOrder(fake, { lines: [{ quantity: 10 }] });
    await runCaseStartJob(makeCaseJob({ zohoSalesOrderId: 'zso-1' }));
    const caseId = fake.rows('operationalCase')[0].id as string;

    const result = await runCaseAdvanceJob(makeCaseJob({ caseId }, { id: 'job_adv' }));

    expect(result).toMatchObject({
      status: 'completed',
      commandId: `ops:case.advance:${caseId}:job_adv:1`,
    });
    expect(fake.rows('operationalCommand').find((c) => c.type === 'case.advance')).toMatchObject({
      actorId: 'job:ops.case.advance',
    });
  });
});

describe('ops.case.reconcile_orders', () => {
  it('encola ops.case.start para órdenes elegibles sin expediente y deduplica en la siguiente corrida', async () => {
    reconcileRows = [
      {
        zohoSalesOrderId: 'zso-10',
        status: 'confirmed',
        shippedStatus: 'pending',
        createdTime: new Date('2026-09-12T10:00:00.000Z'),
        orderDate: null,
        locationId: 'loc-1',
      },
      {
        zohoSalesOrderId: 'zso-11',
        status: 'confirmed',
        shippedStatus: 'pending',
        createdTime: new Date('2026-08-12T10:00:00.000Z'),
        orderDate: null,
        locationId: 'loc-1',
      },
    ];

    const first = await reconcileOrdersWithoutCase();
    const second = await reconcileOrdersWithoutCase();

    expect(first).toEqual({
      skipped: null,
      candidates: 2,
      enqueued: 1,
      deduplicated: 0,
      ineligible: 1,
    });
    expect(second).toMatchObject({ enqueued: 0, deduplicated: 1 });
    expect(fake.rows('backgroundJob')).toEqual([
      expect.objectContaining({
        type: 'ops.case.start',
        dedupeKey: 'case:so:zso-10',
        payload: { zohoSalesOrderId: 'zso-10' },
        createdBy: 'ops.case.reconcile_orders',
      }),
    ]);
    expect(rawQueries[0].sql).toContain('NOT EXISTS');
    expect(rawQueries[0].values).toEqual(
      expect.arrayContaining(['2026-09-01T00:00:00.000', 'draft', 'fulfilled', 200])
    );
    // Policy rejections hold until the order or the config changes; the rest only 30 minutes.
    expect(rawQueries[0].sql).toContain('"errorCode" IN');
    expect(rawQueries[0].values).toEqual(
      expect.arrayContaining(['case_not_eligible', 'invalid_state'])
    );
    const retryAfter = rawQueries[0].values.find(
      (value) =>
        typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}T/.test(value) &&
        Math.abs(Date.parse(`${value}Z`) - (Date.now() - 30 * 60_000)) < 60_000
    );
    expect(retryAfter).toBeDefined();
  });

  it('con el arranque automático apagado no consulta ni encola', async () => {
    seedOperationsConfig(fake, { flags: { salesToCase: false } });
    invalidateOperationsConfigCache();
    await expect(reconcileOrdersWithoutCase()).resolves.toMatchObject({ skipped: 'disabled' });
    expect(rawQueries).toHaveLength(0);
  });
});
