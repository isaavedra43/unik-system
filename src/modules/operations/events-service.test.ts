import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fake, publishRealtime } = await vi.hoisted(async () => {
  const { createOpsFake } = await import('./testing/fixtures');
  return {
    fake: createOpsFake(),
    publishRealtime: vi.fn(async (channel: string, type: string, payload: unknown) => ({
      id: '1',
      channel,
      type,
      payload,
      createdAt: new Date().toISOString(),
    })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: fake.client }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));

import {
  appendEvents,
  areaChannel,
  authorizeOperationsChannel,
  caseChannel,
  dispatchOperationalEvents,
  listAreaEvents,
  listCaseEvents,
  onOperationalEvents,
  publishEventsRealtime,
  recordOperationalEvents,
  toOperationalJson,
} from './events-service';
import { makeCurrentUser } from './testing/fixtures';

const tx = fake.client as unknown as Prisma.TransactionClient;

beforeEach(() => {
  fake.tables.clear();
  vi.clearAllMocks();
});

describe('appendEvents', () => {
  it('inserts in order, returns string ids and serializes payloads to plain JSON', async () => {
    const records = await appendEvents(tx, [
      {
        type: 'case.created',
        actorType: 'system',
        actorId: 'test',
        caseId: 'c1',
        payload: {
          qty: new Prisma.Decimal('1.50'),
          seq: BigInt(9),
          at: new Date('2026-09-15T10:00:00Z'),
          skip: undefined,
        },
      },
      { type: 'demand.created', actorType: 'user', actorId: 'u1', caseId: 'c1', areaKey: 'ventas' },
    ]);
    expect(records.map((r) => r.type)).toEqual(['case.created', 'demand.created']);
    expect(Number(records[1].id)).toBeGreaterThan(Number(records[0].id));
    expect(records[0].payload).toEqual({ qty: '1.5', seq: '9', at: '2026-09-15T10:00:00.000Z' });
    expect(fake.rows('operationalEvent')).toHaveLength(2);
  });

  it('rejects malformed event types', async () => {
    await expect(appendEvents(tx, [{ type: 'Case Created', actorType: 'system' }])).rejects.toThrow(
      /Invalid/
    );
  });

  it('toOperationalJson drops undefined and keeps nested structures', () => {
    expect(toOperationalJson({ a: [1, { b: undefined, c: 'x' }] })).toEqual({ a: [1, { c: 'x' }] });
  });
});

describe('listCaseEvents excluding types', () => {
  it('leaves out the AI turn audit events of a business timeline', async () => {
    await appendEvents(tx, [
      { type: 'step.ready', actorType: 'system', caseId: 'c9' },
      { type: 'ai.turn_skipped', actorType: 'ai', caseId: 'c9' },
      { type: 'ai.turn', actorType: 'ai', caseId: 'c9' },
      { type: 'ai.proposal_created', actorType: 'ai', caseId: 'c9' },
      { type: 'request.created', actorType: 'user', caseId: 'c9' },
    ]);
    const page = await listCaseEvents('c9', { limit: 10, excludeTypes: ['ai.turn', 'ai.turn_skipped', 'ai.turn_failed'] });
    expect(page.events.map((e) => e.type)).toEqual(['step.ready', 'ai.proposal_created', 'request.created']);
  });
});

describe('listCaseEvents / listAreaEvents', () => {
  async function seed(count: number) {
    for (let i = 0; i < count; i++) {
      await appendEvents(tx, [
        {
          type: 'step.ready',
          actorType: 'system',
          caseId: i % 2 === 0 ? 'c1' : 'c2',
          areaKey: 'inventario',
        },
      ]);
    }
  }

  it('returns the newest page oldest-first with cursors to older and newer events', async () => {
    await seed(6); // c1 gets events 1, 3, 5
    const page = await listCaseEvents('c1', { limit: 2 });
    expect(page.events).toHaveLength(2);
    expect(Number(page.events[0].id)).toBeLessThan(Number(page.events[1].id));
    expect(page.olderCursor).toBe(page.events[0].id);

    const older = await listCaseEvents('c1', { beforeId: page.olderCursor!, limit: 2 });
    expect(older.events).toHaveLength(1);
    expect(older.olderCursor).toBeNull();

    const newer = await listCaseEvents('c1', { afterId: older.events[0].id });
    expect(newer.events.map((e) => e.id)).toEqual(page.events.map((e) => e.id));
  });

  it('filters by area and type and validates inputs', async () => {
    await seed(3);
    await appendEvents(tx, [
      { type: 'incident.opened', actorType: 'system', areaKey: 'inventario' },
    ]);
    const page = await listAreaEvents('inventario', { types: ['incident.opened'] });
    expect(page.events.map((e) => e.type)).toEqual(['incident.opened']);
    await expect(listAreaEvents('bodega')).rejects.toMatchObject({ code: 'invalid_payload' });
    await expect(listCaseEvents('c1', { afterId: 'abc' })).rejects.toMatchObject({
      code: 'invalid_payload',
    });
  });
});

describe('realtime and listeners', () => {
  it('publishes one message per case/area channel', async () => {
    const records = await appendEvents(tx, [
      { type: 'workitem.created', actorType: 'system', caseId: 'c1', areaKey: 'inventario' },
      { type: 'request.created', actorType: 'system', caseId: 'c1', areaKey: 'compras' },
    ]);
    await publishEventsRealtime(records, { commandId: 'cmd1', commandType: 'case.start' });
    const channels = publishRealtime.mock.calls.map((c) => c[0]).sort();
    expect(channels).toEqual(
      [areaChannel('compras'), areaChannel('inventario'), caseChannel('c1')].sort()
    );
    const caseMessage = publishRealtime.mock.calls.find((c) => c[0] === 'case:c1')!;
    expect(caseMessage[1]).toBe('ops.events');
    expect((caseMessage[2] as { events: unknown[] }).events).toHaveLength(2);
  });

  it('keeps publishing when one channel fails', async () => {
    publishRealtime.mockRejectedValueOnce(new Error('db down'));
    const records = await appendEvents(tx, [
      { type: 'case.created', actorType: 'system', caseId: 'c1', areaKey: 'ventas' },
    ]);
    await expect(publishEventsRealtime(records)).resolves.toBeUndefined();
    expect(publishRealtime).toHaveBeenCalledTimes(2);
  });

  it('runs every listener, isolates failures and supports unsubscribe', async () => {
    const seen: string[] = [];
    const offFailing = onOperationalEvents(() => {
      throw new Error('listener bug');
    });
    const offGood = onOperationalEvents((events) => {
      seen.push(...events.map((e) => e.type));
    });
    try {
      const records = await recordOperationalEvents([
        { type: 'ai.turn', actorType: 'ai', actorId: 'bot', areaKey: 'compras' },
      ]);
      expect(records).toHaveLength(1);
      expect(seen).toEqual(['ai.turn']);
      offGood();
      await dispatchOperationalEvents(records);
      expect(seen).toEqual(['ai.turn']);
    } finally {
      offFailing();
      offGood();
    }
  });
});

describe('authorizeOperationsChannel', () => {
  const viewer = makeCurrentUser({ id: 'viewer', permissionKeys: ['operations.view'] });
  const stranger = makeCurrentUser({ id: 'stranger' });

  beforeEach(() => {
    fake.seed('area', {
      key: 'compras',
      label: 'Compras',
      responsibleArea: 'compras',
      chatChannelId: 'ch-compras',
    });
    fake.seed('operationalCase', {
      id: 'c1',
      caseSeq: 1,
      caseNumber: 'EXP-000001',
      kind: 'sales_fulfillment',
      sourceType: 'sales_order',
      sourceId: 'so1',
      processVersionId: 'pv1',
      ownerUserId: 'owner',
      chatChannelId: 'room-c1',
    });
  });

  it('area: operations.view or active member of the area channel', async () => {
    expect(await authorizeOperationsChannel(viewer, 'area', 'compras')).toBe(true);
    expect(await authorizeOperationsChannel(viewer, 'area', 'bodega')).toBe(false);
    expect(await authorizeOperationsChannel(stranger, 'area', 'compras')).toBe(false);
    fake.seed('internalChatMember', { channelId: 'ch-compras', userId: 'stranger' });
    expect(await authorizeOperationsChannel(stranger, 'area', 'compras')).toBe(true);
    fake.rows('internalChatMember')[0].leftAt = new Date();
    expect(await authorizeOperationsChannel(stranger, 'area', 'compras')).toBe(false);
  });

  it('case: operations.admin, owner, work item owner/backup or room member (operations.view alone is not enough)', async () => {
    expect(await authorizeOperationsChannel(viewer, 'case', 'c1')).toBe(false);
    expect(await authorizeOperationsChannel(makeCurrentUser({ id: 'boss', permissionKeys: ['operations.admin'] }), 'case', 'c1')).toBe(true);
    expect(await authorizeOperationsChannel(makeCurrentUser({ id: 'owner' }), 'case', 'c1')).toBe(
      true
    );
    expect(await authorizeOperationsChannel(stranger, 'case', 'c1')).toBe(false);
    expect(await authorizeOperationsChannel(stranger, 'case', 'missing')).toBe(false);

    fake.seed('workItem', {
      caseId: 'c1',
      areaKey: 'inventario',
      kind: 'action',
      title: 'Preparar',
      ownerUserId: 'worker',
      backupUserId: 'helper',
      dueAt: new Date(),
    });
    expect(await authorizeOperationsChannel(makeCurrentUser({ id: 'worker' }), 'case', 'c1')).toBe(
      true
    );
    expect(await authorizeOperationsChannel(makeCurrentUser({ id: 'helper' }), 'case', 'c1')).toBe(
      true
    );

    fake.seed('internalChatMember', { channelId: 'room-c1', userId: 'stranger' });
    expect(await authorizeOperationsChannel(stranger, 'case', 'c1')).toBe(true);
  });
});
