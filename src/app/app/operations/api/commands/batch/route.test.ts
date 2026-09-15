import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  return {
    fake: createOpsFake(),
    getCurrentSession: vi.fn(),
    notifyUser: vi.fn(async () => ({ id: 'n', inApp: true, push: false, suppressed: false })),
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
vi.mock('@/modules/auth/authorization', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/auth/authorization')>()),
  getCurrentSession: mocks.getCurrentSession,
}));

import { OperationsError, registerCommand } from '@/modules/operations/commands';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { seedUser } from '@/modules/operations/testing/fixtures';
import { POST as postSingle } from '../route';
import { POST as postBatch } from './route';

const { fake } = mocks;

const echoSchema = z.object({
  value: z.string(),
  fail: z.boolean().optional(),
  crash: z.boolean().optional(),
});

registerCommand<z.output<typeof echoSchema>, { value: string; actorType: string; actorId: string }>(
  'test.batch_echo',
  {
    schema: echoSchema,
    aggregate: 'none',
    async handler(_tx, cmd, ctx) {
      if (cmd.payload.fail)
        throw new OperationsError('invalid_state', 'No se puede en este estado');
      if (cmd.payload.crash) throw new Error('boom');
      ctx.emit('test.batch_echoed', { value: cmd.payload.value });
      return {
        data: { value: cmd.payload.value, actorType: ctx.actor.type, actorId: ctx.actor.id },
      };
    },
  }
);

registerCommand('test.batch_manage', {
  schema: z.object({}),
  permission: 'operations.manage',
  aggregate: 'none',
  async handler() {
    return { data: { ok: true } };
  },
});

registerCommand('test.batch_system_only', {
  schema: z.object({}),
  aggregate: 'none',
  actorTypes: ['system'],
  async handler() {
    return { data: { ok: true } };
  },
});

function request(body: unknown, raw?: string) {
  return new Request('http://localhost/app/operations/api/commands/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

const echo = (commandId: string, payload: Record<string, unknown> = { value: commandId }) => ({
  commandId,
  type: 'test.batch_echo',
  aggregate: { type: 'test', id: commandId },
  payload,
});

let session: { sessionId: string; user: ReturnType<typeof seedUser>['currentUser'] };

beforeEach(() => {
  fake.tables.clear();
  invalidateOperationsConfigCache();
  vi.clearAllMocks();
  session = { sessionId: 's1', user: seedUser(fake, { id: 'driver' }).currentUser };
  mocks.getCurrentSession.mockResolvedValue(session);
});

describe('POST /app/operations/api/commands/batch', () => {
  it('requires a session and executes nothing without it', async () => {
    mocks.getCurrentSession.mockResolvedValue(null);
    const res = await postBatch(
      request({ deviceId: 'dev1', userId: 'driver', commands: [echo('c1')] })
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated' });
    expect(fake.rows('operationalCommand')).toHaveLength(0);
  });

  it('forces the actor to the session user and tags the device', async () => {
    const forged = {
      ...echo('c1'),
      actor: { type: 'system', id: 'ops.supervisor' },
      deviceId: 'other',
    };
    const impersonation = { ...echo('c2'), actor: { type: 'user', id: 'boss' } };
    const res = await postBatch(
      request({ deviceId: 'dev1', userId: 'driver', commands: [forged, impersonation] })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: { status: string }) => r.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(body.results[0].data).toEqual({ value: 'c1', actorType: 'user', actorId: 'driver' });
    expect(body.results[1].data).toMatchObject({ actorId: 'driver' });
    expect(fake.rows('operationalCommand')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'c1',
          actorType: 'user',
          actorId: 'driver',
          deviceId: 'dev1',
        }),
        expect.objectContaining({ id: 'c2', actorId: 'driver', deviceId: 'dev1' }),
      ])
    );
    expect(
      fake
        .rows('operationalEvent')
        .filter((e) => e.type === 'test.batch_echoed')
        .map((e) => e.actorId)
    ).toEqual(['driver', 'driver']);
  });

  it('keeps going after rejections, malformed entries and unexpected failures', async () => {
    const res = await postBatch(
      request({
        deviceId: 'dev1',
        userId: 'driver',
        commands: [
          echo('ok1'),
          echo('bad1', { value: 'x', fail: true }),
          { commandId: 'shape1', aggregate: { type: 'test', id: 'x' } },
          {
            commandId: 'perm1',
            type: 'test.batch_manage',
            aggregate: { type: 't', id: '1' },
            payload: {},
          },
          {
            commandId: 'sys1',
            type: 'test.batch_system_only',
            aggregate: { type: 't', id: '1' },
            payload: {},
          },
          echo('crash1', { value: 'x', crash: true }),
          { commandId: 'unknown1', type: 'test.not_registered', aggregate: { type: 't', id: '1' } },
          echo('ok2'),
        ],
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(
      body.results.map(
        (r: { commandId: string; status: string; errorCode?: string; httpStatus: number }) => [
          r.commandId,
          r.status,
          r.errorCode ?? null,
          r.httpStatus,
        ]
      )
    ).toEqual([
      ['ok1', 'completed', null, 200],
      ['bad1', 'rejected', 'invalid_state', 409],
      ['shape1', 'rejected', 'invalid_payload', 422],
      ['perm1', 'rejected', 'forbidden', 403],
      ['sys1', 'rejected', 'forbidden', 403],
      ['crash1', 'failed', 'internal_error', 500],
      ['unknown1', 'rejected', 'unknown_command', 400],
      ['ok2', 'completed', null, 200],
    ]);
    expect(body.summary).toEqual({ total: 8, completed: 2, pending: 0, rejected: 5, failed: 1 });
  });

  it('executes and stores nothing when the queue belongs to another user of the device', async () => {
    const res = await postBatch(
      request({ deviceId: 'dev1', userId: 'driver-a', commands: [echo('a1'), echo('a2')] })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(
      body.results.map(
        (r: { commandId: string; status: string; errorCode: string; httpStatus: number }) => [
          r.commandId,
          r.status,
          r.errorCode,
          r.httpStatus,
        ]
      )
    ).toEqual([
      ['a1', 'rejected', 'actor_mismatch', 409],
      ['a2', 'rejected', 'actor_mismatch', 409],
    ]);
    expect(fake.rows('operationalCommand')).toHaveLength(0);
    expect(fake.rows('operationalEvent')).toHaveLength(0);

    // A command inside a matching batch that claims another creator is refused alone.
    const mixed = await (
      await postBatch(
        request({
          deviceId: 'dev1',
          userId: 'driver',
          commands: [{ ...echo('m1'), userId: 'driver-a' }, echo('m2')],
        })
      )
    ).json();
    expect(
      mixed.results.map((r: { status: string; errorCode?: string }) => r.errorCode ?? r.status)
    ).toEqual(['actor_mismatch', 'completed']);
    expect(fake.rows('operationalCommand').map((c) => c.id)).toEqual(['m2']);
  });

  it('replays a re-sent batch without executing anything twice', async () => {
    const commands = [echo('r1'), echo('r2', { value: 'r2', fail: true })];
    const first = await (
      await postBatch(request({ deviceId: 'dev1', userId: 'driver', commands }))
    ).json();
    const second = await (
      await postBatch(request({ deviceId: 'dev1', userId: 'driver', commands }))
    ).json();

    expect(second.results.map((r: { status: string }) => r.status)).toEqual([
      'completed',
      'rejected',
    ]);
    expect(second.results.every((r: { replayed?: boolean }) => r.replayed)).toBe(true);
    expect(second.results[0].data).toEqual(first.results[0].data);
    expect(second.results[0].emittedEventIds).toEqual(first.results[0].emittedEventIds);
    expect(
      fake.rows('operationalEvent').filter((e) => e.type === 'test.batch_echoed')
    ).toHaveLength(1);
    expect(fake.rows('operationalCommand')).toHaveLength(2);
  });

  it('retries a command that failed unexpectedly under the same id', async () => {
    await postBatch(
      request({
        deviceId: 'dev1',
        userId: 'driver',
        commands: [echo('x1', { value: 'x', crash: true })],
      })
    );
    expect(fake.rows('operationalCommand')[0]).toMatchObject({ id: 'x1', status: 'failed' });
    const retry = await (
      await postBatch(
        request({
          deviceId: 'dev1',
          userId: 'driver',
          commands: [echo('x1', { value: 'x', crash: true })],
        })
      )
    ).json();
    expect(retry.results[0]).toMatchObject({ status: 'failed', errorCode: 'internal_error' });
  });

  it('rejects oversized batches, invalid envelopes and invalid JSON', async () => {
    const many = Array.from({ length: 51 }, (_, i) => echo(`m${i}`));
    const tooMany = await postBatch(
      request({ deviceId: 'dev1', userId: 'driver', commands: many })
    );
    expect(tooMany.status).toBe(422);
    expect(await tooMany.json()).toMatchObject({ code: 'batch_too_large' });

    const noDevice = await postBatch(request({ userId: 'driver', commands: [echo('a')] }));
    expect(noDevice.status).toBe(422);

    const noUser = await postBatch(request({ deviceId: 'dev1', commands: [echo('a')] }));
    expect(noUser.status).toBe(422);
    expect((await noUser.json()).error).toMatch(/usuario/);

    const broken = await postBatch(request(null, '{"deviceId":'));
    expect(broken.status).toBe(400);
    expect(fake.rows('operationalCommand')).toHaveLength(0);

    const empty = await postBatch(request({ deviceId: 'dev1', userId: 'driver', commands: [] }));
    expect(await empty.json()).toMatchObject({ results: [], summary: { total: 0 } });
  });
});

describe('POST /app/operations/api/commands', () => {
  const single = (body: unknown) =>
    postSingle(
      new Request('http://localhost/app/operations/api/commands', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    );

  it('maps each outcome to its HTTP status with the same controls', async () => {
    const ok = await single({ ...echo('s1'), actor: { type: 'system', id: 'x' } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).result.data).toMatchObject({ actorType: 'user', actorId: 'driver' });

    const rejected = await single(echo('s2', { value: 'x', fail: true }));
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).result).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_state',
      message: 'No se puede en este estado',
    });

    const invalid = await single({ commandId: 's3' });
    expect(invalid.status).toBe(422);

    const crashed = await single(echo('s4', { value: 'x', crash: true }));
    expect(crashed.status).toBe(500);

    const otherUser = await single({ ...echo('s6'), userId: 'someone-else' });
    expect(otherUser.status).toBe(409);
    expect((await otherUser.json()).result).toMatchObject({ errorCode: 'actor_mismatch' });
    expect(fake.rows('operationalCommand').some((c) => c.id === 's6')).toBe(false);

    mocks.getCurrentSession.mockResolvedValue(null);
    expect((await single(echo('s5'))).status).toBe(401);
  });
});
