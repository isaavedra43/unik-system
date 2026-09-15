import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('./testing/fixtures');
  const fake = createOpsFake();
  const txState = { inTx: false };
  const originalTransaction = fake.client.$transaction;
  fake.client.$transaction = async (fn: unknown, options?: unknown) => {
    txState.inTx = true;
    try {
      return await originalTransaction(fn, options);
    } finally {
      txState.inTx = false;
    }
  };
  const notifyCalls: Array<{ input: Record<string, unknown>; inTx: boolean }> = [];
  const realtimeCalls: Array<{ channel: string; type: string; payload: unknown; inTx: boolean }> =
    [];
  const jobCalls: Array<{ input: Record<string, unknown>; inTx: boolean }> = [];
  return {
    fake,
    txState,
    notifyCalls,
    realtimeCalls,
    jobCalls,
    notifyUser: vi.fn(async (input: Record<string, unknown>) => {
      notifyCalls.push({ input, inTx: txState.inTx });
      return { id: `n${notifyCalls.length}`, inApp: true, push: false, suppressed: false };
    }),
    publishRealtime: vi.fn(async (channel: string, type: string, payload: unknown) => {
      realtimeCalls.push({ channel, type, payload, inTx: txState.inTx });
      return {
        id: String(realtimeCalls.length),
        channel,
        type,
        payload,
        createdAt: new Date().toISOString(),
      };
    }),
    wakeJobWorker: vi.fn(),
    responsibleCalls: [] as Array<{ withTx: boolean; inTx: boolean }>,
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));
vi.mock('@/modules/comms/responsibles-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/comms/responsibles-service')>();
  return {
    ...actual,
    resolveResponsible: (area: string, db?: Parameters<typeof actual.resolveResponsible>[1]) => {
      mocks.responsibleCalls.push({ withTx: db !== undefined, inTx: mocks.txState.inTx });
      return actual.resolveResponsible(area, db);
    },
  };
});
vi.mock('@/modules/jobs/job-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/jobs/job-queue')>();
  return {
    ...actual,
    wakeJobWorker: mocks.wakeJobWorker,
    enqueueJob: async (input: Parameters<typeof actual.enqueueJob>[0]) => {
      mocks.jobCalls.push({
        input: input as unknown as Record<string, unknown>,
        inTx: mocks.txState.inTx,
      });
      return actual.enqueueJob(input);
    },
  };
});

import {
  OperationsError,
  commandPayloadHash,
  executeCommand,
  registerCommand,
  requireCommandContext,
  versionedAggregate,
  type DomainCommand,
} from './commands';
import { onOperationalEvents, onOperationalEventsInTransaction } from './events-service';
import { invalidateOperationsConfigCache } from './operations-config';
import { seedArea, seedResponsible, seedUser } from './testing/fixtures';

const { fake } = mocks;
const NOW = new Date('2026-09-15T15:00:00.000Z');
const calls = { touch: 0, flaky: 0 };

registerCommand('test.touch_case', {
  schema: z.object({ priority: z.enum(['normal', 'high', 'urgent']) }),
  permission: 'operations.manage',
  aggregate: versionedAggregate('operational_case', 'operationalCase'),
  async handler(tx, cmd, ctx) {
    calls.touch += 1;
    await tx.operationalCase.update({
      where: { id: cmd.aggregate.id },
      data: { priority: cmd.payload.priority },
    });
    ctx.emit(
      'case.status_changed',
      { priority: cmd.payload.priority },
      {
        caseId: cmd.aggregate.id,
        areaKey: 'ventas',
        objectType: 'operational_case',
        objectId: cmd.aggregate.id,
      }
    );
    ctx.outbox({
      type: 'ops.test_job',
      payload: { caseId: cmd.aggregate.id },
      dedupeKey: `test:${cmd.commandId}`,
    });
    ctx.notify({ userId: 'owner', category: 'ops_workitem', title: 'Cambió la prioridad' });
    const item = await ctx.createWorkItem({
      areaKey: 'inventario',
      kind: 'verification',
      title: 'Verificar existencias',
      caseId: cmd.aggregate.id,
    });
    ctx.realtime('user:owner', 'custom.ping', { ok: true });
    return { data: { workItemId: item.id } };
  },
});

let flakyShouldFail = true;
registerCommand('test.flaky', {
  schema: z.object({}),
  aggregate: 'none',
  async handler(_tx, _cmd, ctx) {
    calls.flaky += 1;
    if (flakyShouldFail) throw new Error('db hiccup');
    ctx.emit('case.created', {}, { caseId: 'c-flaky' });
  },
});

registerCommand('test.reject', {
  schema: z.object({}),
  aggregate: 'none',
  async handler(_tx, _cmd, ctx) {
    ctx.emit('case.created', {}, { caseId: 'c-reject' });
    throw new OperationsError('invalid_state', 'El expediente ya está cerrado');
  },
});

registerCommand('test.assign', {
  schema: z.object({
    areaKey: z.enum([
      'ventas',
      'compras',
      'inventario',
      'manufactura',
      'logistica',
      'contabilidad',
      'administracion',
    ]),
  }),
  aggregate: 'none',
  async handler(_tx, cmd, ctx) {
    const item = await ctx.createWorkItem({
      areaKey: cmd.payload.areaKey,
      kind: 'action',
      title: 'Trabajo de prueba',
    });
    return { data: { ownerUserId: item.ownerUserId, backupUserId: item.backupUserId } };
  },
});

registerCommand('test.incident', {
  schema: z.object({ dedupeKey: z.string() }),
  aggregate: 'none',
  async handler(_tx, cmd, ctx) {
    const { incident, created } = await ctx.openIncident({
      kind: 'stock_conflict',
      areaKey: 'inventario',
      title: 'Dos reservas para el mismo stock',
      dedupeKey: cmd.payload.dedupeKey,
      severity: 'critical',
      caseId: 'case1',
    });
    return { data: { incidentId: incident.id, created } };
  },
});

registerCommand('test.request', {
  schema: z.object({
    from: z.string(),
    to: z.string(),
    kind: z.string(),
    payload: z.unknown(),
    freeText: z.string().optional(),
  }),
  aggregate: 'none',
  async handler(_tx, cmd, ctx) {
    const { request, workItem } = await ctx.createAreaRequest({
      caseId: 'case1',
      fromAreaKey: cmd.payload.from,
      toAreaKey: cmd.payload.to,
      kind: cmd.payload.kind,
      objectType: 'case_demand',
      objectId: 'd1',
      title: 'Faltan 15 m² de Loseta Perla',
      payload: cmd.payload.payload,
      freeText: cmd.payload.freeText,
    });
    return { data: { requestId: request.id, workItemId: workItem.id } };
  },
});

registerCommand('test.relate', {
  schema: z.object({}),
  aggregate: 'none',
  async handler(_tx, _cmd, ctx) {
    await ctx.relate(
      { type: 'operational_case', id: 'case1' },
      { type: 'sales_order', id: 'so1' },
      'fulfills'
    );
  },
});

registerCommand('test.system_only', {
  schema: z.object({}),
  aggregate: 'none',
  actorTypes: ['system'],
  async handler(_tx, _cmd, ctx) {
    ctx.emit('supervisor.tick', { checked: 0 });
  },
});

let managerUser: ReturnType<typeof seedUser>['currentUser'];
let viewerUser: ReturnType<typeof seedUser>['currentUser'];

function touch(overrides: Partial<DomainCommand<unknown>> = {}): DomainCommand<unknown> {
  return {
    commandId: 'cmd-1',
    type: 'test.touch_case',
    actor: { type: 'user', id: 'manager' },
    aggregate: { type: 'operational_case', id: 'case1' },
    payload: { priority: 'high' },
    ...overrides,
  };
}

function system(type: string, payload: unknown, commandId: string): DomainCommand<unknown> {
  return {
    commandId,
    type,
    actor: { type: 'system', id: 'test' },
    aggregate: { type: 'test', id: commandId },
    payload,
  };
}

function caseRow() {
  return fake.rows('operationalCase').find((r) => r.id === 'case1')!;
}

beforeEach(() => {
  fake.tables.clear();
  vi.clearAllMocks();
  mocks.notifyCalls.length = 0;
  mocks.realtimeCalls.length = 0;
  mocks.jobCalls.length = 0;
  mocks.responsibleCalls.length = 0;
  calls.touch = 0;
  calls.flaky = 0;
  flakyShouldFail = true;
  invalidateOperationsConfigCache();

  managerUser = seedUser(fake, {
    id: 'manager',
    permissions: ['operations.view', 'operations.manage'],
  }).currentUser;
  viewerUser = seedUser(fake, { id: 'viewer', permissions: ['operations.view'] }).currentUser;
  seedUser(fake, { id: 'owner' });
  seedUser(fake, { id: 'inv_lead' });
  seedUser(fake, { id: 'inv_backup' });
  seedUser(fake, { id: 'buyer' });
  seedUser(fake, { id: 'buyer_backup' });
  seedResponsible(fake, { area: 'inventario', userId: 'inv_lead', backupUserId: 'inv_backup' });
  seedResponsible(fake, { area: 'compras', userId: 'buyer', backupUserId: 'buyer_backup' });
  fake.seed('operationalCase', {
    id: 'case1',
    caseSeq: 1,
    caseNumber: 'EXP-000001',
    kind: 'sales_fulfillment',
    sourceType: 'sales_order',
    sourceId: 'so1',
    processVersionId: 'pv1',
    ownerUserId: 'owner',
    version: 1,
  });
});

describe('executeCommand — happy path', () => {
  it('writes state, events, jobs, notifications and audit inside the transaction; realtime only after commit', async () => {
    const eventInserts: boolean[] = [];
    const originalInsert = fake.client.operationalEvent.createManyAndReturn;
    const insertSpy = vi
      .spyOn(fake.client.operationalEvent, 'createManyAndReturn')
      .mockImplementation(async (args: unknown) => {
        eventInserts.push(mocks.txState.inTx);
        return originalInsert(args);
      });

    let result: Awaited<ReturnType<typeof executeCommand<{ workItemId: string }>>>;
    try {
      result = await executeCommand<{ workItemId: string }>(touch(), managerUser, { now: NOW });
    } finally {
      insertSpy.mockRestore();
    }

    expect(result).toMatchObject({ status: 'completed', aggregateVersion: 2, commandId: 'cmd-1' });
    expect(result.replayed).toBeUndefined();
    expect(caseRow()).toMatchObject({ version: 2, priority: 'high' });
    expect(eventInserts).toEqual([true]);

    // Events: the handler's event + workitem.created.
    const events = fake.rows('operationalEvent');
    expect(events.map((e) => e.type).sort()).toEqual(['case.status_changed', 'workitem.created']);
    expect(result.emittedEventIds).toHaveLength(2);
    expect(
      events.every(
        (e) => e.commandId === 'cmd-1' && e.actorType === 'user' && e.actorId === 'manager'
      )
    ).toBe(true);

    // Work item: responsible of inventario with backup, SLA of verification (120 min).
    const [item] = fake.rows('workItem');
    expect(result.createdWorkItemIds).toEqual([item.id]);
    expect(result.data).toEqual({ workItemId: item.id });
    expect(item).toMatchObject({
      ownerUserId: 'inv_lead',
      backupUserId: 'inv_backup',
      areaKey: 'inventario',
      status: 'open',
    });
    expect(item.dueAt.toISOString()).toBe('2026-09-15T17:00:00.000Z');

    // Jobs and notifications inside the transaction, with tx.
    expect(mocks.jobCalls).toHaveLength(1);
    expect(mocks.jobCalls[0]).toMatchObject({ inTx: true, input: { type: 'ops.test_job' } });
    expect(mocks.jobCalls[0].input.tx).toBeDefined();
    expect(fake.rows('backgroundJob')).toEqual([
      expect.objectContaining({ type: 'ops.test_job', dedupeKey: 'test:cmd-1' }),
    ]);
    expect(
      mocks.notifyCalls.map((c) => [c.input.userId, c.input.category, c.inTx, Boolean(c.input.tx)])
    ).toEqual([
      ['owner', 'ops_workitem', true, true],
      ['inv_lead', 'ops_workitem', true, true],
    ]);
    expect(mocks.notifyCalls.every((c) => c.input.actorUserId === 'manager')).toBe(true);

    // Audit for human actors, inside the transaction.
    expect(fake.rows('auditLog')).toEqual([
      expect.objectContaining({
        actorUserId: 'manager',
        action: 'operations.command.test.touch_case',
        targetId: 'case1',
      }),
    ]);

    // Ledger closed with the stored result.
    const [ledger] = fake.rows('operationalCommand');
    expect(ledger).toMatchObject({
      id: 'cmd-1',
      status: 'completed',
      actorId: 'manager',
      aggregateId: 'case1',
    });
    expect(ledger.result).toMatchObject({
      status: 'completed',
      emittedEventIds: result.emittedEventIds,
    });

    // Realtime only after the commit.
    expect(mocks.realtimeCalls.length).toBeGreaterThan(0);
    expect(mocks.realtimeCalls.every((c) => !c.inTx)).toBe(true);
    expect(mocks.realtimeCalls.map((c) => c.channel).sort()).toEqual(
      [
        'area:inventario',
        'area:ventas',
        'case:case1',
        'user:inv_backup',
        'user:inv_lead',
        'user:owner',
      ].sort()
    );
    expect(mocks.wakeJobWorker).toHaveBeenCalledTimes(1);
  });

  it('invokes the post-commit listeners with the emitted events', async () => {
    const seen: string[][] = [];
    const off = onOperationalEvents((events) => {
      seen.push(events.map((e) => e.type));
    });
    try {
      await executeCommand(touch(), managerUser, { now: NOW });
      expect(seen).toEqual([['case.status_changed', 'workitem.created']]);
    } finally {
      off();
    }
  });
});

describe('executeCommand — idempotency', () => {
  it('replays the stored result for a repeated commandId without running the handler again', async () => {
    const first = await executeCommand(touch(), managerUser, { now: NOW });
    const eventsBefore = fake.rows('operationalEvent').length;
    const realtimeBefore = mocks.realtimeCalls.length;

    const second = await executeCommand(touch(), managerUser, { now: NOW });

    expect(calls.touch).toBe(1);
    expect(second).toMatchObject({
      status: 'completed',
      replayed: true,
      emittedEventIds: first.emittedEventIds,
    });
    expect(fake.rows('operationalEvent')).toHaveLength(eventsBefore);
    expect(fake.rows('workItem')).toHaveLength(1);
    expect(caseRow().version).toBe(2);
    expect(mocks.realtimeCalls).toHaveLength(realtimeBefore);
  });

  it('rejects the same commandId with a different payload', async () => {
    await executeCommand(touch(), managerUser, { now: NOW });
    const other = await executeCommand(touch({ payload: { priority: 'urgent' } }), managerUser, {
      now: NOW,
    });
    expect(other).toMatchObject({ status: 'rejected', errorCode: 'command_id_conflict' });
    expect(calls.touch).toBe(1);
    expect(caseRow().priority).toBe('high');
  });

  it('answers `accepted` while the same command is still in flight', async () => {
    const cmd = touch({ commandId: 'cmd-inflight' });
    fake.seed('operationalCommand', {
      id: 'cmd-inflight',
      type: cmd.type,
      actorType: 'user',
      actorId: 'manager',
      aggregateType: 'operational_case',
      aggregateId: 'case1',
      payloadHash: commandPayloadHash(cmd),
      status: 'accepted',
      // The ledger runs on the wall clock, whatever `now` the caller injects.
      receivedAt: new Date(Date.now() - 10_000),
    });
    const result = await executeCommand(cmd, managerUser, { now: NOW });
    expect(result).toMatchObject({ status: 'accepted', replayed: true, emittedEventIds: [] });
    expect(calls.touch).toBe(0);
  });

  it('reclaims an abandoned in-flight claim and executes it', async () => {
    const cmd = touch({ commandId: 'cmd-stale' });
    fake.seed('operationalCommand', {
      id: 'cmd-stale',
      type: cmd.type,
      actorType: 'user',
      actorId: 'manager',
      aggregateType: 'operational_case',
      aggregateId: 'case1',
      payloadHash: commandPayloadHash(cmd),
      status: 'accepted',
      receivedAt: new Date(Date.now() - 5 * 60_000),
    });
    const result = await executeCommand(cmd, managerUser, { now: NOW });
    expect(result).toMatchObject({ status: 'completed' });
    expect(calls.touch).toBe(1);
    expect(fake.rows('operationalCommand')).toHaveLength(1);
  });

  it('never treats a fresh claim as abandoned because the caller injected an old `now`', async () => {
    const cmd = touch({ commandId: 'cmd-old-clock' });
    const tickStart = new Date(Date.now() - 3.5 * 60_000); // a long supervisor tick
    fake.seed('operationalCommand', {
      id: 'cmd-old-clock',
      type: cmd.type,
      actorType: 'user',
      actorId: 'manager',
      aggregateType: 'operational_case',
      aggregateId: 'case1',
      payloadHash: commandPayloadHash(cmd),
      status: 'accepted',
      receivedAt: new Date(Date.now() - 5_000),
    });
    const result = await executeCommand(cmd, managerUser, { now: tickStart });
    expect(result).toMatchObject({ status: 'accepted', replayed: true });
    expect(calls.touch).toBe(0);

    const fresh = await executeCommand(touch({ commandId: 'cmd-fresh' }), managerUser, {
      now: tickStart,
    });
    expect(fresh.status).toBe('completed');
    const row = fake.rows('operationalCommand').find((c) => c.id === 'cmd-fresh')!;
    expect(Date.now() - (row.receivedAt as Date).getTime()).toBeLessThan(60_000);
    expect(Date.now() - (row.completedAt as Date).getTime()).toBeLessThan(60_000);
  });

  it('never replays nor reclaims a command id of another actor', async () => {
    const first = await executeCommand(touch({ commandId: 'cmd-owned' }), managerUser, {
      now: NOW,
    });
    expect(first.status).toBe('completed');
    const intruder = seedUser(fake, {
      id: 'intruder',
      permissions: ['operations.view', 'operations.manage'],
    }).currentUser;
    const replay = await executeCommand(
      touch({ commandId: 'cmd-owned', actor: { type: 'user', id: 'intruder' } }),
      intruder,
      { now: NOW }
    );
    expect(replay).toMatchObject({ status: 'rejected', errorCode: 'command_id_conflict' });
    expect(replay).not.toHaveProperty('data');
    expect(replay.replayed).toBeUndefined();

    const cmd = system('test.flaky', {}, 'cmd-failed-other');
    await expect(executeCommand(cmd, null, { now: NOW })).rejects.toThrow('db hiccup');
    flakyShouldFail = false;
    const takeover = await executeCommand(
      { ...cmd, actor: { type: 'system', id: 'someone-else' } },
      null,
      { now: NOW }
    );
    expect(takeover).toMatchObject({ status: 'rejected', errorCode: 'command_id_conflict' });
    expect(fake.rows('operationalCommand').find((c) => c.id === 'cmd-failed-other')).toMatchObject({
      status: 'failed',
      actorId: 'test',
    });
    expect(calls.flaky).toBe(1);
  });

  it('marks unexpected failures as failed and lets the same commandId succeed later', async () => {
    const cmd = system('test.flaky', {}, 'cmd-flaky');
    await expect(executeCommand(cmd, null, { now: NOW })).rejects.toThrow('db hiccup');
    expect(fake.rows('operationalCommand')[0]).toMatchObject({
      status: 'failed',
      errorCode: 'internal_error',
    });
    expect(mocks.realtimeCalls).toHaveLength(0);

    flakyShouldFail = false;
    const retry = await executeCommand(cmd, null, { now: NOW });
    expect(retry).toMatchObject({ status: 'completed' });
    expect(calls.flaky).toBe(2);
    expect(fake.rows('operationalCommand')[0].status).toBe('completed');
  });
});

describe('executeCommand — in-transaction reactions and pinned config', () => {
  it('enqueues the reactions with the state and rolls them back with it', async () => {
    const seen: Array<{ inTx: boolean; types: string[] }> = [];
    const off = onOperationalEventsInTransaction(async (_tx, events, sink) => {
      seen.push({ inTx: mocks.txState.inTx, types: events.map((e) => e.type) });
      for (const event of events) {
        if (event.caseId === 'c-flaky') {
          sink.outbox({ type: 'ops.test_reaction', payload: {}, dedupeKey: `r:${event.id}` });
        }
      }
    });
    try {
      await expect(
        executeCommand(system('test.reject', {}, 'cmd-reaction-reject'), null, { now: NOW })
      ).resolves.toMatchObject({ status: 'rejected' });
      expect(seen).toEqual([]); // the handler threw before the events were written

      flakyShouldFail = false;
      await executeCommand(system('test.flaky', {}, 'cmd-reaction'), null, { now: NOW });
      expect(seen).toEqual([{ inTx: true, types: ['case.created'] }]);
      expect(mocks.jobCalls.filter((c) => c.input.type === 'ops.test_reaction')).toEqual([
        expect.objectContaining({ inTx: true }),
      ]);
      expect(fake.rows('backgroundJob').map((j) => j.type)).toContain('ops.test_reaction');
      expect(mocks.wakeJobWorker).toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('a failing reaction fails the command instead of committing without it', async () => {
    const off = onOperationalEventsInTransaction(async () => {
      throw new Error('reaction broke');
    });
    try {
      flakyShouldFail = false;
      await expect(
        executeCommand(system('test.flaky', {}, 'cmd-reaction-broken'), null, { now: NOW })
      ).rejects.toThrow('reaction broke');
      // (FakePrisma does not roll back; PostgreSQL discards the events with the transaction.)
      expect(fake.rows('operationalCommand')[0]).toMatchObject({ status: 'failed' });
      expect(mocks.realtimeCalls).toHaveLength(0);
    } finally {
      off();
    }
  });

  it('reads responsibles and the config inside the transaction without asking the pool again', async () => {
    const { getOperationsConfig } = await import('./operations-config');
    const configRead = vi.spyOn(fake.client.integrationConfig, 'findUnique');
    registerCommand('test.config_inside', {
      schema: z.object({}),
      aggregate: 'none',
      async handler(_tx, _cmd, ctx) {
        const before = configRead.mock.calls.length;
        invalidateOperationsConfigCache(); // the 10 s cache expired mid-transaction
        const config = await getOperationsConfig();
        await ctx.createWorkItem({ areaKey: 'inventario', kind: 'action', title: 'Contar' });
        return {
          data: {
            configReadsInside: configRead.mock.calls.length - before,
            sla: config.slaDefaults.action,
          },
        };
      },
    });
    try {
      const result = await executeCommand<{ configReadsInside: number; sla: number }>(
        system('test.config_inside', {}, 'cmd-config-inside'),
        null,
        { now: NOW }
      );
      expect(result.data).toEqual({ configReadsInside: 0, sla: 240 });
    } finally {
      configRead.mockRestore();
    }
    expect(mocks.responsibleCalls.length).toBeGreaterThan(0);
    expect(mocks.responsibleCalls.every((call) => call.withTx && call.inTx)).toBe(true);
  });
});

describe('executeCommand — versions and concurrency', () => {
  it('rejects a stale expectedVersion, stores the rejection and replays it', async () => {
    caseRow().version = 3;
    const cmd = touch({ commandId: 'cmd-stale-version', expectedVersion: 1 });
    const result = await executeCommand(cmd, managerUser, { now: NOW });
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'version_conflict' });
    expect(calls.touch).toBe(0);
    expect(caseRow().version).toBe(3);
    expect(fake.rows('operationalEvent')).toHaveLength(0);
    expect(mocks.realtimeCalls).toHaveLength(0);
    expect(fake.rows('operationalCommand')[0]).toMatchObject({
      status: 'rejected',
      errorCode: 'version_conflict',
    });

    const again = await executeCommand(cmd, managerUser, { now: NOW });
    expect(again).toMatchObject({
      status: 'rejected',
      errorCode: 'version_conflict',
      replayed: true,
    });
  });

  it('accepts a matching expectedVersion', async () => {
    const result = await executeCommand(touch({ expectedVersion: 1 }), managerUser, { now: NOW });
    expect(result).toMatchObject({ status: 'completed', aggregateVersion: 2 });
  });

  it('retries once when another transaction bumped the version in between', async () => {
    const original = fake.client.operationalCase.updateMany;
    let raced = false;
    const spy = vi
      .spyOn(fake.client.operationalCase, 'updateMany')
      .mockImplementation(async (args: unknown) => {
        if (!raced) {
          raced = true;
          caseRow().version += 1; // a concurrent command committed first
          return { count: 0 };
        }
        return original(args);
      });
    try {
      const result = await executeCommand(touch(), managerUser, { now: NOW });
      expect(result).toMatchObject({ status: 'completed', aggregateVersion: 3 });
      expect(calls.touch).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('gives up with concurrency_conflict after the retry also loses, but keeps the id retryable', async () => {
    const spy = vi
      .spyOn(fake.client.operationalCase, 'updateMany')
      .mockResolvedValue({ count: 0 } as never);
    try {
      const result = await executeCommand(touch({ commandId: 'cmd-race' }), managerUser, {
        now: NOW,
      });
      expect(result).toMatchObject({ status: 'rejected', errorCode: 'concurrency_conflict' });
      expect(calls.touch).toBe(0);
      expect(mocks.realtimeCalls).toHaveLength(0);
      // A transient loss is not stored as a final rejection.
      expect(fake.rows('operationalCommand')[0]).toMatchObject({
        status: 'failed',
        errorCode: 'concurrency_conflict',
      });
    } finally {
      spy.mockRestore();
    }
    // Deterministic ids (supervisor buckets, job confirmations) run again.
    const again = await executeCommand(touch({ commandId: 'cmd-race' }), managerUser, { now: NOW });
    expect(again).toMatchObject({ status: 'completed' });
    expect(again.replayed).toBeUndefined();
    expect(calls.touch).toBe(1);
  });

  it('rejects when the aggregate does not exist', async () => {
    const result = await executeCommand(
      touch({ aggregate: { type: 'operational_case', id: 'nope' } }),
      managerUser,
      { now: NOW }
    );
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'not_found' });
  });
});

describe('executeCommand — validation and permissions', () => {
  it('denies a user without the command permission and stores nothing', async () => {
    const result = await executeCommand(
      touch({ actor: { type: 'user', id: 'viewer' } }),
      viewerUser,
      { now: NOW }
    );
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
    expect(fake.rows('operationalCommand')).toHaveLength(0);
    expect(calls.touch).toBe(0);
  });

  it('requires a session for user actors and that it matches the actor', async () => {
    expect(await executeCommand(touch(), null, { now: NOW })).toMatchObject({
      errorCode: 'unauthenticated',
    });
    expect(
      await executeCommand(touch({ actor: { type: 'user', id: 'someone' } }), managerUser, {
        now: NOW,
      })
    ).toMatchObject({
      errorCode: 'actor_mismatch',
    });
  });

  it('rejects invalid payloads, unknown types and malformed commands before the ledger', async () => {
    expect(
      await executeCommand(touch({ payload: { priority: 'max' } }), managerUser, { now: NOW })
    ).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_payload',
    });
    expect(
      await executeCommand(touch({ type: 'test.unknown' }), managerUser, { now: NOW })
    ).toMatchObject({
      errorCode: 'unknown_command',
    });
    expect(await executeCommand(touch({ commandId: '' }), managerUser, { now: NOW })).toMatchObject(
      {
        errorCode: 'invalid_payload',
      }
    );
    expect(
      await executeCommand(touch({ aggregate: { type: 'work_item', id: 'case1' } }), managerUser, {
        now: NOW,
      })
    ).toMatchObject({ errorCode: 'invalid_payload' });
    expect(
      await executeCommand(touch({ occurredAt: 'ayer' }), managerUser, { now: NOW })
    ).toMatchObject({
      errorCode: 'invalid_payload',
    });
    expect(fake.rows('operationalCommand')).toHaveLength(0);
  });

  it('restricts actor types and runs trusted system commands without a session or audit row', async () => {
    const asUser = await executeCommand(
      { ...system('test.system_only', {}, 'cmd-sys-user'), actor: { type: 'user', id: 'manager' } },
      managerUser,
      { now: NOW }
    );
    expect(asUser).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
    const asSystem = await executeCommand(system('test.system_only', {}, 'cmd-sys'), null, {
      now: NOW,
    });
    expect(asSystem).toMatchObject({ status: 'completed', aggregateVersion: 0 });
    expect(fake.rows('auditLog')).toHaveLength(0);
  });

  it('stores domain rejections thrown by the handler and publishes nothing', async () => {
    const result = await executeCommand(system('test.reject', {}, 'cmd-reject'), null, {
      now: NOW,
    });
    expect(result).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_state',
      message: 'El expediente ya está cerrado',
    });
    expect(fake.rows('operationalCommand')[0]).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_state',
    });
    expect(fake.rows('operationalEvent')).toHaveLength(0);
    expect(mocks.realtimeCalls).toHaveLength(0);
    expect(mocks.notifyCalls).toHaveLength(0);
  });

  it('uses the device time for events, clamping clocks that run ahead', async () => {
    await executeCommand(
      touch({ commandId: 'cmd-past', occurredAt: '2026-09-15T12:00:00Z' }),
      managerUser,
      { now: NOW }
    );
    expect(
      fake
        .rows('operationalEvent')
        .every((e) => e.occurredAt.toISOString() === '2026-09-15T12:00:00.000Z')
    ).toBe(true);

    fake.rows('operationalEvent').length = 0;
    caseRow().version = 2;
    await executeCommand(
      touch({ commandId: 'cmd-future', occurredAt: '2026-09-16T12:00:00Z' }),
      managerUser,
      { now: NOW }
    );
    expect(
      fake.rows('operationalEvent').every((e) => e.occurredAt.getTime() === NOW.getTime())
    ).toBe(true);
  });

  it('refuses context-bound helpers outside a command', () => {
    expect(() => requireCommandContext(fake.client as unknown as Prisma.TransactionClient)).toThrow(
      expect.objectContaining({ code: 'outside_command' })
    );
  });
});

describe('CommandContext primitives', () => {
  it('createWorkItem falls back from an inactive responsible to the backup', async () => {
    seedUser(fake, { id: 'log_off', isActive: false });
    seedUser(fake, { id: 'log_backup' });
    seedResponsible(fake, { area: 'logistica', userId: 'log_off', backupUserId: 'log_backup' });
    const result = await executeCommand(
      system('test.assign', { areaKey: 'logistica' }, 'a1'),
      null,
      { now: NOW }
    );
    expect(result.data).toEqual({ ownerUserId: 'log_backup', backupUserId: null });
  });

  it('createWorkItem falls back to the area lead, then Administración, then a super admin', async () => {
    seedUser(fake, { id: 'mf_lead' });
    seedArea(fake, 'manufactura', { leadUserId: 'mf_lead' });
    expect(
      (
        await executeCommand(system('test.assign', { areaKey: 'manufactura' }, 'a2'), null, {
          now: NOW,
        })
      ).data
    ).toEqual({
      ownerUserId: 'mf_lead',
      backupUserId: null,
    });

    seedUser(fake, { id: 'admin_resp' });
    seedResponsible(fake, { area: 'administracion', userId: 'admin_resp' });
    expect(
      (
        await executeCommand(system('test.assign', { areaKey: 'contabilidad' }, 'a3'), null, {
          now: NOW,
        })
      ).data
    ).toEqual({
      ownerUserId: 'admin_resp',
      backupUserId: null,
    });

    fake.rows('responsible').splice(
      fake.rows('responsible').findIndex((r) => r.area === 'administracion'),
      1
    );
    seedUser(fake, { id: 'root', superAdmin: true });
    expect(
      (await executeCommand(system('test.assign', { areaKey: 'ventas' }, 'a4'), null, { now: NOW }))
        .data
    ).toEqual({
      ownerUserId: 'root',
      backupUserId: null,
    });
  });

  it('rejects with no_responsible when nobody can own the work', async () => {
    const result = await executeCommand(system('test.assign', { areaKey: 'ventas' }, 'a5'), null, {
      now: NOW,
    });
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'no_responsible' });
  });

  it('openIncident is idempotent by dedupeKey across commands', async () => {
    const first = await executeCommand<{ created: boolean; incidentId: string }>(
      system('test.incident', { dedupeKey: 'stock:sku1:bodega' }, 'i1'),
      null,
      { now: NOW }
    );
    const second = await executeCommand<{ created: boolean; incidentId: string }>(
      system('test.incident', { dedupeKey: 'stock:sku1:bodega' }, 'i2'),
      null,
      { now: NOW }
    );
    expect(first.data).toMatchObject({ created: true });
    expect(second.data).toMatchObject({ created: false, incidentId: first.data!.incidentId });
    expect(fake.rows('incident')).toHaveLength(1);
    expect(fake.rows('incident')[0]).toMatchObject({
      ownerUserId: 'inv_lead',
      severity: 'critical',
    });
    expect(fake.rows('operationalEvent').filter((e) => e.type === 'incident.opened')).toHaveLength(
      1
    );
    expect(mocks.notifyCalls.filter((c) => c.input.category === 'ops_incident')).toHaveLength(1);
  });

  it('createAreaRequest validates the catalog and links a work item for the destination responsible', async () => {
    const payload = {
      demandId: 'd1',
      sku: 'LP-01',
      productName: 'Loseta Perla',
      missingQty: 15,
      unit: 'm2',
      neededBy: '2026-09-18',
    };
    const bad = await executeCommand(
      system(
        'test.request',
        { from: 'ventas', to: 'compras', kind: 'purchase_shortfall', payload },
        'r0'
      ),
      null,
      { now: NOW }
    );
    expect(bad).toMatchObject({ status: 'rejected', errorCode: 'invalid_request' });

    const ok = await executeCommand<{ requestId: string; workItemId: string }>(
      system(
        'test.request',
        { from: 'inventario', to: 'compras', kind: 'purchase_shortfall', payload },
        'r1'
      ),
      null,
      { now: NOW }
    );
    expect(ok.status).toBe('completed');
    const [request] = fake.rows('areaRequest');
    const [item] = fake.rows('workItem');
    expect(request).toMatchObject({
      id: ok.data!.requestId,
      workItemId: item.id,
      ownerUserId: 'buyer',
      backupUserId: 'buyer_backup',
      status: 'sent',
      blocksDelivery: true,
      priority: 'high',
      createdByType: 'system',
      createdById: 'test',
    });
    expect(item).toMatchObject({
      objectType: 'area_request',
      objectId: request.id,
      ownerUserId: 'buyer',
      areaKey: 'compras',
    });
    expect(
      fake
        .rows('operationalEvent')
        .map((e) => e.type)
        .sort()
    ).toEqual(['request.created', 'workitem.created']);
    expect(mocks.notifyCalls.map((c) => [c.input.userId, c.input.category])).toEqual([
      ['buyer', 'ops_request'],
    ]);
    expect(ok.createdWorkItemIds).toEqual([item.id]);
  });

  it('relate upserts the relation and reopens it when it had been closed', async () => {
    await executeCommand(system('test.relate', {}, 'rel1'), null, { now: NOW });
    await executeCommand(system('test.relate', {}, 'rel2'), null, { now: NOW });
    expect(fake.rows('objectRelation')).toHaveLength(1);
    fake.rows('objectRelation')[0].validTo = new Date('2026-09-14T00:00:00Z');
    await executeCommand(system('test.relate', {}, 'rel3'), null, { now: NOW });
    expect(fake.rows('objectRelation')).toEqual([
      expect.objectContaining({ relation: 'fulfills', validTo: null, validFrom: NOW }),
    ]);
  });
});
