import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('./testing/fixtures');
  return {
    fake: createOpsFake(),
    notifyUser: vi.fn<(input: Record<string, unknown>) => Promise<Record<string, unknown>>>(
      async () => ({ id: 'n', inApp: true, push: false, suppressed: false })
    ),
    publishRealtime: vi.fn<
      (channel: string, type: string, payload: unknown) => Promise<Record<string, unknown>>
    >(async () => ({ id: '1', channel: '', type: '', payload: {}, createdAt: '' })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));

import {
  AREA_REQUEST_COMMANDS,
  AREA_REQUEST_TRANSITIONS,
  AREA_REQUEST_AUTO_ACK_JOB,
  autoAcknowledgeAreaRequest,
  runAreaRequestAutoAckJob,
  expireAreaRequestsForCase,
  getAreaRequest,
  isAreaRequestOverdue,
  listAreaRequests,
  markAreaRequestOverdue,
  nextAreaRequestStatus,
  type AreaRequestCommandData,
} from './area-requests-service';
import { executeCommand, registerCommand } from './commands';
import { invalidateOperationsConfigCache } from './operations-config';
import { AREA_KEYS } from './types';
import { WORK_ITEM_COMMANDS } from './work-items-service';
import { seedArea, seedResponsible, seedUser } from './testing/fixtures';

const { fake } = mocks;
const NOW = new Date('2026-09-15T15:00:00.000Z');

type SessionUser = ReturnType<typeof seedUser>['currentUser'];
type UserKey =
  'buyer' | 'buyerBackup' | 'comprasLead' | 'invLead' | 'stranger' | 'manager' | 'viewer' | 'bot';
let users: Record<UserKey, SessionUser>;

registerCommand('test.create_request', {
  schema: z.object({}),
  aggregate: 'none',
  async handler(_tx, _cmd, ctx) {
    const { request, workItem } = await ctx.createAreaRequest({
      caseId: 'case1',
      fromAreaKey: 'inventario',
      toAreaKey: 'compras',
      kind: 'info',
      objectType: 'case_demand',
      objectId: 'd1',
      title: '¿Hay 15 m² de Loseta Perla?',
      payload: { question: '¿Hay 15 m² de Loseta Perla?' },
      freeText: '¿Pueden confirmar hoy?',
    });
    return { data: { requestId: request.id, workItemId: workItem.id } };
  },
});

registerCommand('test.request_overdue', {
  schema: z.object({ requestId: z.string(), level: z.number().int() }),
  aggregate: 'none',
  async handler(tx, cmd) {
    const outcome = await markAreaRequestOverdue(tx, cmd.payload.requestId, cmd.payload.level);
    return {
      data: { emitted: outcome.emitted, applied: outcome.escalation?.applied ?? null },
    };
  },
});

registerCommand('test.expire_case', {
  schema: z.object({}),
  aggregate: 'none',
  async handler(tx) {
    const expired = await expireAreaRequestsForCase(tx, 'case1', 'Expediente cancelado');
    return { data: { ids: expired.map((r) => r.id) } };
  },
});

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

/** Runs the pending `ops.request.auto_ack` jobs like the worker would. */
async function drainAutoAckJobs(): Promise<Array<Record<string, unknown>>> {
  const outcomes: Array<Record<string, unknown>> = [];
  for (const job of fake
    .rows('backgroundJob')
    .filter((j) => j.type === AREA_REQUEST_AUTO_ACK_JOB && j.status === 'pending')) {
    outcomes.push(
      await runAreaRequestAutoAckJob({
        id: String(job.id),
        type: AREA_REQUEST_AUTO_ACK_JOB,
        payload: job.payload,
        attempt: 1,
        signal: new AbortController().signal,
        async setProgress() {},
        log() {},
      })
    );
    job.status = 'completed';
    job.dedupeKey = null;
  }
  return outcomes;
}

async function createRequest(): Promise<{ requestId: string; workItemId: string }> {
  const id = nextId('create');
  const result = await executeCommand<{ requestId: string; workItemId: string }>(
    {
      commandId: id,
      type: 'test.create_request',
      actor: { type: 'user', id: 'invLead' },
      aggregate: { type: 'test', id },
      payload: {},
    },
    users.invLead,
    { now: NOW }
  );
  expect(result.status).toBe('completed');
  await drainAutoAckJobs();
  return result.data!;
}

function act(
  actor: SessionUser | 'system',
  action: keyof typeof AREA_REQUEST_COMMANDS,
  requestId: string,
  payload: Record<string, unknown> = {}
) {
  const system = actor === 'system';
  return executeCommand<AreaRequestCommandData>(
    {
      commandId: nextId(action),
      type: AREA_REQUEST_COMMANDS[action],
      actor: system ? { type: 'system', id: 'ops.case' } : { type: 'user', id: actor.id },
      aggregate: { type: 'area_request', id: requestId },
      payload,
    },
    system ? null : actor,
    { now: NOW }
  );
}

function workItemCommand(
  actor: SessionUser | 'system',
  type: string,
  workItemId: string,
  payload: Record<string, unknown> = {}
) {
  const system = actor === 'system';
  return executeCommand(
    {
      commandId: nextId('wi'),
      type,
      actor: system ? { type: 'system', id: 'ops.case' } : { type: 'user', id: actor.id },
      aggregate: { type: 'work_item', id: workItemId },
      payload,
    },
    system ? null : actor,
    { now: NOW }
  );
}

function systemCommand(type: string, payload: unknown, now = NOW) {
  const id = nextId('sys');
  return executeCommand<Record<string, unknown>>(
    {
      commandId: id,
      type,
      actor: { type: 'system', id: 'ops.supervisor' },
      aggregate: { type: 'test', id },
      payload,
    },
    null,
    { now }
  );
}

const requestRow = (id: string) => fake.rows('areaRequest').find((r) => r.id === id)!;
const itemRow = (id: string) => fake.rows('workItem').find((r) => r.id === id)!;
const eventTypes = () => fake.rows('operationalEvent').map((e) => e.type as string);
const notifications = () => mocks.notifyUser.mock.calls.map(([input]) => input);

beforeEach(() => {
  fake.tables.clear();
  vi.clearAllMocks();
  invalidateOperationsConfigCache();
  users = {
    buyer: seedUser(fake, { id: 'buyer', name: 'Ana' }).currentUser,
    buyerBackup: seedUser(fake, { id: 'buyerBackup', name: 'Luis' }).currentUser,
    comprasLead: seedUser(fake, { id: 'comprasLead' }).currentUser,
    invLead: seedUser(fake, { id: 'invLead', name: 'Iván' }).currentUser,
    stranger: seedUser(fake, { id: 'stranger' }).currentUser,
    manager: seedUser(fake, { id: 'manager', permissions: ['operations.manage'] }).currentUser,
    viewer: seedUser(fake, { id: 'viewer', permissions: ['operations.view'] }).currentUser,
    bot: seedUser(fake, { id: 'bot', isBot: true, permissions: ['operations.manage'] }).currentUser,
  };
  seedUser(fake, { id: 'gone', isActive: false });
  for (const key of AREA_KEYS) {
    seedArea(fake, key, key === 'compras' ? { leadUserId: 'comprasLead' } : {});
  }
  seedResponsible(fake, { area: 'compras', userId: 'buyer', backupUserId: 'buyerBackup' });
  seedResponsible(fake, { area: 'inventario', userId: 'invLead' });
  fake.seed('operationalCase', {
    id: 'case1',
    caseSeq: 1,
    caseNumber: 'EXP-000001',
    kind: 'sales_fulfillment',
    sourceType: 'sales_order',
    sourceId: 'so1',
    processVersionId: 'pv1',
    ownerUserId: 'seller',
  });
});

describe('area request rules (pure)', () => {
  it('encodes the unified lifecycle', () => {
    expect(nextAreaRequestStatus('acknowledge', 'sent')).toBe('acknowledged');
    expect(nextAreaRequestStatus('acknowledge', 'accepted')).toBeNull();
    expect(nextAreaRequestStatus('accept', 'blocked')).toBe('accepted');
    expect(nextAreaRequestStatus('block', 'blocked')).toBeNull();
    expect(nextAreaRequestStatus('resolve', 'sent')).toBe('resolved');
    expect(nextAreaRequestStatus('reject', 'resolved')).toBeNull();
    expect(nextAreaRequestStatus('cancel', 'expired')).toBeNull();
    for (const action of ['resolve', 'reject', 'cancel', 'expire'] as const) {
      expect(AREA_REQUEST_TRANSITIONS[action].from).toEqual([
        'sent',
        'acknowledged',
        'accepted',
        'blocked',
      ]);
    }
    const dueAt = new Date('2026-09-15T14:00:00.000Z');
    expect(isAreaRequestOverdue({ status: 'accepted', dueAt }, NOW)).toBe(true);
    expect(isAreaRequestOverdue({ status: 'resolved', dueAt }, NOW)).toBe(false);
  });
});

describe('automatic acknowledge', () => {
  it('enqueues the acknowledgement inside the creating transaction', async () => {
    const id = nextId('create');
    const result = await executeCommand<{ requestId: string }>(
      {
        commandId: id,
        type: 'test.create_request',
        actor: { type: 'user', id: 'invLead' },
        aggregate: { type: 'test', id },
        payload: {},
      },
      users.invLead,
      { now: NOW }
    );
    const requestId = result.data!.requestId;
    // Committed with the request (a restart right after the commit loses nothing)…
    expect(fake.rows('backgroundJob').filter((j) => j.type === AREA_REQUEST_AUTO_ACK_JOB)).toEqual([
      expect.objectContaining({
        status: 'pending',
        dedupeKey: `request-ack:${requestId}`,
        payload: { requestId },
      }),
    ]);
    expect(requestRow(requestId).status).toBe('sent');
    // …and acknowledged once by the job, even if it runs twice.
    expect(await drainAutoAckJobs()).toEqual([{ requestId, status: 'completed', errorCode: null }]);
    expect(await autoAcknowledgeAreaRequest(requestId)).toBeNull();
    expect(requestRow(requestId).status).toBe('acknowledged');
  });

  it('acknowledges a new request with an active owner right after the commit', async () => {
    const { requestId, workItemId } = await createRequest();
    expect(requestRow(requestId)).toMatchObject({
      status: 'acknowledged',
      ownerUserId: 'buyer',
      backupUserId: 'buyerBackup',
      workItemId,
      createdByType: 'user',
      createdById: 'invLead',
    });
    expect(itemRow(workItemId)).toMatchObject({ status: 'open', objectType: 'area_request' });
    expect(eventTypes()).toEqual(['workitem.created', 'request.created', 'request.acknowledged']);
    expect(
      fake.rows('operationalCommand').find((c) => c.id === `request-ack:${requestId}`)
    ).toMatchObject({
      status: 'completed',
      actorType: 'system',
    });
    expect(mocks.publishRealtime).toHaveBeenCalledWith(
      'area:inventario',
      'ops.requests',
      expect.objectContaining({ requestId, status: 'acknowledged', direction: 'out' })
    );
  });

  it('skips requests without an active human owner and other events', async () => {
    fake.seed('areaRequest', {
      id: 'orphan',
      caseId: 'case1',
      fromAreaKey: 'inventario',
      toAreaKey: 'compras',
      kind: 'info',
      objectType: 'case_demand',
      objectId: 'd1',
      title: 'Pregunta',
      payload: { question: 'x' },
      dueAt: NOW,
      ownerUserId: 'gone',
      createdByType: 'system',
    });
    expect(await autoAcknowledgeAreaRequest('orphan')).toBeNull();
    expect(await autoAcknowledgeAreaRequest('missing')).toBeNull();
    expect(requestRow('orphan').status).toBe('sent');
    const job = (payload: unknown) =>
      runAreaRequestAutoAckJob({
        id: 'j',
        type: AREA_REQUEST_AUTO_ACK_JOB,
        payload,
        attempt: 1,
        signal: new AbortController().signal,
        async setProgress() {},
        log() {},
      });
    expect(await job({ requestId: 'orphan' })).toEqual({
      skipped: 'not_applicable',
      requestId: 'orphan',
    });
    expect(await job({})).toEqual({ skipped: 'invalid_payload' });
  });
});

describe('decisions of the destination area', () => {
  it('accepts, blocks, unblocks and resolves, keeping the work item in step', async () => {
    const { requestId, workItemId } = await createRequest();
    mocks.notifyUser.mockClear();

    const accepted = await act(users.buyer, 'accept', requestId, { note: 'Lo reviso' });
    expect(accepted).toMatchObject({
      status: 'completed',
      data: { status: 'accepted', previousStatus: 'acknowledged', workItemStatus: 'in_progress' },
    });
    expect(requestRow(requestId)).toMatchObject({
      status: 'accepted',
      answer: expect.objectContaining({ kind: 'accepted', note: 'Lo reviso', by: 'buyer' }),
    });
    expect(itemRow(workItemId)).toMatchObject({ status: 'in_progress', version: 2 });
    expect(notifications()).toContainEqual(
      expect.objectContaining({
        userId: 'invLead',
        category: 'ops_request',
        type: 'ops_request_accepted',
        title: 'Compras aceptó: ¿Hay 15 m² de Loseta Perla?',
      })
    );

    await act(users.buyerBackup, 'block', requestId, { reason: 'Proveedor sin existencias' });
    expect(requestRow(requestId)).toMatchObject({
      status: 'blocked',
      answer: expect.objectContaining({ kind: 'blocked', reason: 'Proveedor sin existencias' }),
    });
    expect(itemRow(workItemId)).toMatchObject({
      status: 'waiting',
      waitReason: 'Proveedor sin existencias',
    });

    await act(users.buyer, 'accept', requestId);
    expect(itemRow(workItemId)).toMatchObject({ status: 'in_progress', waitReason: null });

    const resolved = await act(users.buyer, 'resolve', requestId, {
      answer: 'Llegan el jueves',
      data: { eta: '2026-09-17' },
    });
    expect(resolved.data).toMatchObject({ status: 'resolved', workItemStatus: 'done' });
    expect(requestRow(requestId)).toMatchObject({
      status: 'resolved',
      answeredAt: NOW,
      closedAt: NOW,
      answer: expect.objectContaining({
        kind: 'resolved',
        text: 'Llegan el jueves',
        data: { eta: '2026-09-17' },
      }),
    });
    expect(itemRow(workItemId)).toMatchObject({
      status: 'done',
      completedBy: 'buyer',
      result: {
        requestStatus: 'resolved',
        answer: 'Llegan el jueves',
        answerData: { eta: '2026-09-17' },
      },
    });
    expect(eventTypes()).toEqual(
      expect.arrayContaining([
        'request.accepted',
        'request.blocked',
        'request.resolved',
        'workitem.started',
        'workitem.waiting',
        'workitem.completed',
      ])
    );

    expect(await act(users.buyer, 'resolve', requestId, { answer: 'Otra vez' })).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_state',
      message: 'No se puede resolver una solicitud resuelta',
    });
  });

  it('rejects a request and closes the work item as done', async () => {
    const { requestId, workItemId } = await createRequest();
    const rejected = await act(users.comprasLead, 'reject', requestId, {
      reason: 'No manejamos ese producto',
    });
    expect(rejected.data).toMatchObject({ status: 'rejected' });
    expect(itemRow(workItemId)).toMatchObject({
      status: 'done',
      result: { requestStatus: 'rejected', reason: 'No manejamos ese producto' },
    });
    expect(notifications()).toContainEqual(
      expect.objectContaining({ userId: 'invLead', type: 'ops_request_rejected' })
    );
  });

  it('only lets human responsibles of the destination or managers decide', async () => {
    const { requestId } = await createRequest();
    for (const actor of [users.stranger, users.viewer, users.invLead, users.bot]) {
      expect(await act(actor, 'accept', requestId)).toMatchObject({
        status: 'rejected',
        errorCode: 'forbidden',
      });
    }
    const byAi = await executeCommand(
      {
        commandId: nextId('ai'),
        type: AREA_REQUEST_COMMANDS.accept,
        actor: { type: 'ai', id: 'bot' },
        aggregate: { type: 'area_request', id: requestId },
        payload: {},
      },
      users.bot,
      { now: NOW }
    );
    expect(byAi).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
    expect(requestRow(requestId).status).toBe('acknowledged');

    expect((await act(users.manager, 'accept', requestId)).status).toBe('completed');
    expect(await act(users.manager, 'accept', requestId)).toMatchObject({
      errorCode: 'invalid_state',
    });
    expect(await act(users.buyer, 'block', requestId, {})).toMatchObject({
      errorCode: 'invalid_payload',
    });
  });

  it('lets the requester or a system actor cancel, but not outsiders', async () => {
    const first = await createRequest();
    expect(await act(users.stranger, 'cancel', first.requestId, { reason: 'Ya no' })).toMatchObject(
      {
        errorCode: 'forbidden',
      }
    );
    mocks.notifyUser.mockClear();
    const cancelled = await act(users.invLead, 'cancel', first.requestId, {
      reason: 'El cliente canceló la línea',
    });
    expect(cancelled.data).toMatchObject({ status: 'cancelled', workItemStatus: 'cancelled' });
    expect(requestRow(first.requestId).closedAt).toEqual(NOW);
    expect(notifications().map((n) => [n.userId, n.type])).toEqual(
      expect.arrayContaining([
        ['buyer', 'ops_request_cancelled'],
        ['buyerBackup', 'ops_request_cancelled'],
      ])
    );

    const second = await createRequest();
    expect(
      (await act('system', 'cancel', second.requestId, { reason: 'Replaneación' })).status
    ).toBe('completed');
  });

  it('expires requests only for system actors and managers', async () => {
    const { requestId, workItemId } = await createRequest();
    expect(await act(users.buyer, 'expire', requestId)).toMatchObject({ errorCode: 'forbidden' });
    const expired = await act('system', 'expire', requestId, { reason: 'Expediente cerrado' });
    expect(expired.data).toMatchObject({ status: 'expired' });
    expect(itemRow(workItemId).status).toBe('cancelled');

    const other = await createRequest();
    expect((await act(users.manager, 'expire', other.requestId)).status).toBe('completed');
  });
});

describe('working the linked item from "Mi trabajo"', () => {
  it('moves the request when the work item is started, put on hold or completed', async () => {
    const { requestId, workItemId } = await createRequest();

    expect((await workItemCommand(users.buyer, WORK_ITEM_COMMANDS.start, workItemId)).status).toBe(
      'completed'
    );
    expect(requestRow(requestId).status).toBe('accepted');
    expect(itemRow(workItemId).status).toBe('in_progress');

    await workItemCommand(users.buyer, WORK_ITEM_COMMANDS.wait, workItemId, {
      reason: 'Esperando cotización',
    });
    expect(requestRow(requestId).status).toBe('blocked');
    expect(itemRow(workItemId).status).toBe('waiting');

    expect(
      await workItemCommand(users.buyer, WORK_ITEM_COMMANDS.complete, workItemId)
    ).toMatchObject({ status: 'rejected', errorCode: 'invalid_payload' });
    expect(requestRow(requestId).status).toBe('blocked');

    expect(
      await workItemCommand('system', WORK_ITEM_COMMANDS.complete, workItemId, { note: 'Listo' })
    ).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });

    const done = await workItemCommand(users.buyer, WORK_ITEM_COMMANDS.complete, workItemId, {
      note: 'Compra confirmada',
    });
    expect(done.status).toBe('completed');
    expect(requestRow(requestId)).toMatchObject({
      status: 'resolved',
      answer: expect.objectContaining({ text: 'Compra confirmada' }),
    });
    expect(itemRow(workItemId).status).toBe('done');
  });

  it('keeps the request owner in sync when the work item is reassigned', async () => {
    const { requestId, workItemId } = await createRequest();
    await workItemCommand(users.manager, WORK_ITEM_COMMANDS.reassign, workItemId, {
      ownerUserId: 'stranger',
    });
    expect(requestRow(requestId)).toMatchObject({
      ownerUserId: 'stranger',
      backupUserId: 'buyerBackup',
    });
    // The new owner is now a responsible of the request.
    expect((await act(users.stranger, 'accept', requestId)).status).toBe('completed');
  });
});

describe('supervisor helpers', () => {
  it('flags an overdue request once and escalates its work item level by level', async () => {
    const { requestId, workItemId } = await createRequest();
    const late = new Date('2026-09-15T20:00:00.000Z');
    const overdueEvents = () => eventTypes().filter((type) => type === 'request.overdue');

    expect((await systemCommand('test.request_overdue', { requestId, level: 0 })).data).toEqual({
      emitted: false,
      applied: null,
    });
    expect(
      (await systemCommand('test.request_overdue', { requestId, level: 0 }, late)).data
    ).toEqual({ emitted: true, applied: true });
    expect(overdueEvents()).toHaveLength(1);
    expect(itemRow(workItemId)).toMatchObject({ escalationLevel: 0 });
    expect(notifications()).toContainEqual(
      expect.objectContaining({ userId: 'invLead', type: 'ops_request_overdue' })
    );

    expect(
      (await systemCommand('test.request_overdue', { requestId, level: 0 }, late)).data
    ).toEqual({ emitted: false, applied: false });
    expect(
      (await systemCommand('test.request_overdue', { requestId, level: 1 }, late)).data
    ).toEqual({ emitted: false, applied: true });
    expect(itemRow(workItemId)).toMatchObject({ escalationLevel: 1, backupUserId: 'comprasLead' });
    expect(overdueEvents()).toHaveLength(1);
  });

  it('expires every open request of a case', async () => {
    const a = await createRequest();
    const b = await createRequest();
    await act(users.buyer, 'resolve', b.requestId, { answer: 'Sí hay' });
    const c = await createRequest();
    const result = await systemCommand('test.expire_case', {});
    expect((result.data as { ids: string[] }).ids.sort()).toEqual(
      [a.requestId, c.requestId].sort()
    );
    expect(requestRow(a.requestId).status).toBe('expired');
    expect(requestRow(b.requestId).status).toBe('resolved');
    expect(itemRow(c.workItemId).status).toBe('cancelled');
  });
});

describe('area request reads', () => {
  it('lists incoming and outgoing requests for those who can see the area', async () => {
    const { requestId } = await createRequest();
    const incoming = await listAreaRequests(users.viewer, 'compras', {}, { now: NOW });
    expect(incoming.items).toEqual([
      expect.objectContaining({
        id: requestId,
        fromAreaLabel: 'Inventario',
        toAreaLabel: 'Compras',
        kindLabel: 'Pregunta a otra área',
        statusLabel: 'Recibida',
        ownerName: 'Ana',
        backupName: 'Luis',
        createdByName: 'Iván',
        caseNumber: 'EXP-000001',
        freeText: '¿Pueden confirmar hoy?',
        overdue: false,
      }),
    ]);
    expect(
      (await listAreaRequests(users.viewer, 'inventario', { direction: 'out' })).items.map(
        (r) => r.id
      )
    ).toEqual([requestId]);
    expect((await listAreaRequests(users.viewer, 'inventario')).items).toEqual([]);
    await expect(listAreaRequests(users.comprasLead, 'compras')).resolves.toMatchObject({
      nextCursor: null,
    });
    await expect(listAreaRequests(users.stranger, 'compras')).rejects.toMatchObject({
      code: 'forbidden',
    });

    await act(users.buyer, 'resolve', requestId, { answer: 'Sí' });
    expect((await listAreaRequests(users.viewer, 'compras')).items).toEqual([]);
    expect(
      (await listAreaRequests(users.viewer, 'compras', { scope: 'closed' })).items.map((r) => r.id)
    ).toEqual([requestId]);
  });

  it('returns one request with the permissions of each side', async () => {
    const { requestId } = await createRequest();
    expect((await getAreaRequest(users.buyer, requestId)).permissions).toEqual({
      canAcknowledge: false,
      canAccept: true,
      canBlock: true,
      canResolve: true,
      canReject: true,
      canCancel: true,
    });
    expect((await getAreaRequest(users.invLead, requestId)).permissions).toMatchObject({
      canAccept: false,
      canResolve: false,
      canCancel: true,
    });
    await expect(getAreaRequest(users.stranger, requestId)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
