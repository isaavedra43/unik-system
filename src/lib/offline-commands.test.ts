import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_ID_KEY,
  MAX_COMMAND_FAILURES,
  createMemoryCommandStorage,
  createOfflineCommandClient,
  withMemoryFallback,
  type ClientCommandResult,
  type CommandQueueStorage,
  type FlushSummary,
  type QueuedCommand,
  type SyncTargets,
} from './offline-commands';

function result(
  commandId: string,
  status: ClientCommandResult['status'] = 'completed',
  extra: Partial<ClientCommandResult> = {}
): ClientCommandResult {
  return {
    commandId,
    type: 'workitem.start',
    status,
    aggregateVersion: 1,
    emittedEventIds: [],
    createdWorkItemIds: [],
    ...extra,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup(
  options: {
    keyValue?: { get(k: string): string | null; set(k: string, v: string): void };
    storage?: CommandQueueStorage;
    userId?: string | null;
  } = {}
) {
  let online = true;
  let clock = 1_000;
  let ids = 0;
  const kv = new Map<string, string>();
  const storage = options.storage ?? createMemoryCommandStorage();
  const fetchMock = vi.fn<typeof fetch>();
  const client = createOfflineCommandClient({
    userId: options.userId === undefined ? 'u1' : options.userId,
    storage,
    fetch: fetchMock,
    isOnline: () => online,
    now: () => ++clock,
    randomId: () => `id-${++ids}`,
    keyValue: options.keyValue ?? {
      get: (key) => kv.get(key) ?? null,
      set: (key, value) => void kv.set(key, value),
    },
  });
  return {
    client,
    storage,
    fetchMock,
    kv,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

const command = (commandId?: string) => ({
  type: 'workitem.start',
  aggregate: { type: 'work_item', id: 'wi1' },
  payload: { note: 'ok' },
  ...(commandId ? { commandId } : {}),
});

const bodyOf = (call: Parameters<typeof fetch>) => JSON.parse(String(call[1]?.body));

afterEach(() => {
  vi.useRealTimers();
});

describe('submit', () => {
  it('sends online commands right away with the device id', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(json({ result: result('c1') }));

    const outcome = await client.submit(command('c1'));
    expect(outcome).toMatchObject({
      queued: false,
      commandId: 'c1',
      result: { status: 'completed', httpStatus: 200 },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/app/operations/api/commands');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body).toMatchObject({
      commandId: 'c1',
      type: 'workitem.start',
      aggregate: { type: 'work_item', id: 'wi1' },
      payload: { note: 'ok' },
      deviceId: client.deviceId(),
      userId: 'u1',
    });
    expect(Date.parse(body.occurredAt)).not.toBeNaN();
    expect(await client.pending()).toEqual([]);
  });

  it('generates a command id when none is given', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockImplementation(async (_url, init) =>
      json({ result: result(JSON.parse(String(init?.body)).commandId) })
    );
    const outcome = await client.submit(command());
    expect(outcome.commandId).toBe('id-1');
  });

  it('returns business rejections without queuing them', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(
      json(
        { result: result('c2', 'rejected', { errorCode: 'forbidden', message: 'Sin permiso' }) },
        403
      )
    );
    const outcome = await client.submit(command('c2'));
    expect(outcome).toMatchObject({
      queued: false,
      result: { status: 'rejected', errorCode: 'forbidden', httpStatus: 403 },
    });
    expect(await client.pending()).toEqual([]);
  });

  it('queues when offline, on network or server errors and when the session expired', async () => {
    const { client, fetchMock, setOnline } = setup();
    setOnline(false);
    expect(await client.submit(command('off'))).toEqual({
      queued: true,
      commandId: 'off',
      reason: 'offline',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    setOnline(true);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await client.submit(command('net'))).toMatchObject({ queued: true, reason: 'network' });
    fetchMock.mockResolvedValueOnce(json({ result: result('srv', 'failed') }, 500));
    expect(await client.submit(command('srv'))).toMatchObject({ queued: true, reason: 'server' });
    fetchMock.mockResolvedValueOnce(json({ error: 'No autenticado' }, 401));
    expect(await client.submit(command('auth'))).toMatchObject({
      queued: true,
      reason: 'unauthenticated',
    });

    expect((await client.pending()).map((c) => c.commandId)).toEqual(['off', 'net', 'srv', 'auth']);
    expect((await client.pending()).every((c) => c.userId === 'u1')).toBe(true);
    expect(client.getState().pending).toBe(4);
  });

  it('keeps a command the server is still running under the same id', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(
      json({ result: result('dup', 'accepted', { replayed: true }) }, 202)
    );
    expect(await client.submit(command('dup'))).toEqual({
      queued: true,
      commandId: 'dup',
      reason: 'in_flight',
    });
    expect((await client.pending()).map((c) => c.commandId)).toEqual(['dup']);

    fetchMock.mockResolvedValueOnce(json({ results: [result('dup', 'failed')] }));
    await client.flush();
    expect((await client.pending()).map((c) => [c.commandId, c.failures])).toEqual([['dup', 1]]);
  });

  it('queues a command the session answers as created by another user', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(
      json({ result: result('mine', 'rejected', { errorCode: 'actor_mismatch' }) }, 409)
    );
    expect(await client.submit(command('mine'))).toMatchObject({
      queued: true,
      reason: 'actor_mismatch',
    });
    expect((await client.pending()).map((c) => c.commandId)).toEqual(['mine']);
  });

  it('refuses to create a command without a signed-in user', async () => {
    const { client, fetchMock } = setup({ userId: null });
    await expect(client.submit(command('anon'))).rejects.toThrow(/inicia sesión/);
    await expect(client.enqueue(command('anon'))).rejects.toThrow(/inicia sesión/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await client.pending()).toEqual([]);
  });
});

describe('flush', () => {
  it('sends the queue as a batch and keeps only what is not final', async () => {
    const { client, fetchMock, setOnline } = setup();
    setOnline(false);
    for (const id of ['c1', 'c2', 'c3', 'c4']) await client.submit(command(id));
    setOnline(true);
    fetchMock.mockResolvedValueOnce(
      json({
        results: [
          result('c1'),
          result('c2', 'rejected', { errorCode: 'invalid_state', message: 'Ya terminado' }),
          result('c3', 'failed', { message: 'Error inesperado' }),
          result('c4', 'accepted'),
        ],
      })
    );

    const summary = await client.flush();
    expect(summary).toMatchObject({ sent: 4, completed: 1, rejected: 1, kept: 2, stoppedBy: null });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/app/operations/api/commands/batch');
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body.deviceId).toBe(client.deviceId());
    expect(body.userId).toBe('u1');
    expect(body.commands.map((c: { commandId: string }) => c.commandId)).toEqual([
      'c1',
      'c2',
      'c3',
      'c4',
    ]);
    expect(body.commands[0]).not.toHaveProperty('attempts');

    const pending = await client.pending();
    expect(pending.map((c) => [c.commandId, c.attempts, c.failures, c.lastError])).toEqual([
      ['c3', 1, 1, 'Error inesperado'],
      ['c4', 0, 0, 'offline'],
    ]);
    expect(client.getState()).toMatchObject({ pending: 2, flushing: false });
    expect(client.getState().lastResults.map((r) => r.status)).toEqual(['completed', 'rejected']);
  });

  it('sends at most 50 commands per request, oldest first', async () => {
    const { client, fetchMock } = setup();
    for (let i = 0; i < 120; i++) {
      await client.enqueue(command(`q${String(i).padStart(3, '0')}`));
    }
    fetchMock.mockImplementation(async (_url, init) =>
      json({
        results: JSON.parse(String(init?.body)).commands.map((c: { commandId: string }) =>
          result(c.commandId)
        ),
      })
    );
    const summary = await client.flush();
    expect(fetchMock.mock.calls.map((call) => bodyOf(call).commands.length)).toEqual([50, 50, 20]);
    expect(bodyOf(fetchMock.mock.calls[0]).commands[0].commandId).toBe('q000');
    expect(summary).toMatchObject({ sent: 120, completed: 120, kept: 0 });
    expect(await client.pending()).toEqual([]);
  });

  it('stops on network errors, expired sessions and when offline without losing commands', async () => {
    const { client, fetchMock, setOnline } = setup();
    await client.enqueue(command('a'));
    await client.enqueue(command('b'));

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await client.flush()).toMatchObject({ stoppedBy: 'network', kept: 2, sent: 0 });
    expect((await client.pending()).map((c) => c.attempts)).toEqual([1, 1]);

    fetchMock.mockResolvedValueOnce(json({ error: 'No autenticado' }, 401));
    expect(await client.flush()).toMatchObject({ stoppedBy: 'unauthenticated', kept: 2 });
    expect((await client.pending()).map((c) => c.attempts)).toEqual([1, 1]);

    fetchMock.mockResolvedValueOnce(json({ error: 'caído' }, 503));
    expect(await client.flush()).toMatchObject({ stoppedBy: 'server', kept: 2 });

    setOnline(false);
    expect(await client.flush()).toMatchObject({ stoppedBy: 'offline', kept: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(client.getState().online).toBe(false);
  });

  it('runs one flush at a time', async () => {
    const { client, fetchMock } = setup();
    await client.enqueue(command('x'));
    let release!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)));

    const first = client.flush();
    const second = client.flush();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(client.getState().flushing).toBe(true);
    release(json({ results: [result('x')] }));
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.getState().flushing).toBe(false);
  });

  it('never sends the commands another user left on the device, and never drops them', async () => {
    const storage = createMemoryCommandStorage();
    const driverA = setup({ storage, userId: 'driver-a' });
    driverA.setOnline(false);
    await driverA.client.submit(command('a-delivery'));
    await driverA.client.submit(command('a-count'));
    expect(driverA.client.getState()).toMatchObject({ pending: 2, pendingOtherUsers: 0 });

    // Driver B signs in on the same phone (same IndexedDB queue).
    const driverB = setup({ storage, userId: 'driver-b' });
    await driverB.client.enqueue(command('b-start'));
    driverB.fetchMock.mockImplementation(async (_url, init) =>
      json({
        results: JSON.parse(String(init?.body)).commands.map((c: { commandId: string }) =>
          result(c.commandId)
        ),
      })
    );
    const summary = await driverB.client.flush();
    expect(summary).toMatchObject({ sent: 1, completed: 1, kept: 0 });
    const sent = bodyOf(driverB.fetchMock.mock.calls[0]);
    expect(sent.userId).toBe('driver-b');
    expect(sent.commands.map((c: { commandId: string }) => c.commandId)).toEqual(['b-start']);
    expect(driverB.client.getState()).toMatchObject({ pending: 0, pendingOtherUsers: 2 });
    expect((await storage.list()).map((c) => [c.commandId, c.userId])).toEqual([
      ['a-delivery', 'driver-a'],
      ['a-count', 'driver-a'],
    ]);

    // Back on A's session the same client sends A's work.
    driverB.client.setUserId('driver-a');
    await vi.waitFor(() => expect(driverB.client.getState().pending).toBe(2));
    await driverB.client.flush();
    expect(bodyOf(driverB.fetchMock.mock.calls[1]).userId).toBe('driver-a');
    expect(await storage.list()).toEqual([]);
  });

  it('keeps the batch when the server says the session belongs to someone else', async () => {
    const { client, fetchMock } = setup();
    await client.enqueue(command('m1'));
    await client.enqueue(command('m2'));
    fetchMock.mockResolvedValueOnce(
      json({
        results: ['m1', 'm2'].map((id) =>
          result(id, 'rejected', { errorCode: 'actor_mismatch', message: 'Otro usuario' })
        ),
      })
    );
    expect(await client.flush()).toMatchObject({
      stoppedBy: 'actor_mismatch',
      sent: 0,
      rejected: 0,
      kept: 2,
    });
    expect((await client.pending()).map((c) => [c.commandId, c.attempts, c.failures])).toEqual([
      ['m1', 0, 0],
      ['m2', 0, 0],
    ]);
    expect(client.getState().lastError).toBe('Otro usuario');
  });

  it('splits a batch the server refuses as too large and rejects only the oversized command', async () => {
    const { client, fetchMock } = setup();
    for (const id of ['s1', 's2', 'big', 's4', 's5']) await client.enqueue(command(id));
    fetchMock.mockImplementation(async (_url, init) => {
      const ids = JSON.parse(String(init?.body)).commands.map(
        (c: { commandId: string }) => c.commandId
      ) as string[];
      if (ids.includes('big')) return json({ error: 'La solicitud es demasiado grande' }, 413);
      return json({ results: ids.map((id) => result(id)) });
    });
    const summary = await client.flush();
    // 5 → 413 → [3, 2]; 3 → 413 → [2, 1]; the single oversized command is rejected locally.
    expect(fetchMock.mock.calls.map((call) => bodyOf(call).commands.length)).toEqual([
      5, 3, 2, 1, 2,
    ]);
    expect(summary).toMatchObject({ completed: 4, rejected: 1, kept: 0, stoppedBy: null });
    expect(summary.results.find((r) => r.commandId === 'big')).toMatchObject({
      status: 'rejected',
      errorCode: 'payload_too_large',
      httpStatus: 413,
    });
    expect(client.getState().lastResults.map((r) => r.commandId)).toEqual([
      's1',
      's2',
      'big',
      's4',
      's5',
    ]);
    expect(await client.pending()).toEqual([]);
  });

  it('stops sending a command the server keeps failing until the user retries it', async () => {
    const { client, fetchMock } = setup();
    await client.enqueue(command('bad'));
    await client.enqueue(command('good'));
    fetchMock.mockImplementation(async (_url, init) =>
      json({
        results: JSON.parse(String(init?.body)).commands.map((c: { commandId: string }) =>
          result(c.commandId, 'failed', { errorCode: 'internal_error' })
        ),
      })
    );
    for (let i = 0; i < MAX_COMMAND_FAILURES; i++) await client.flush();
    expect(client.getState()).toMatchObject({ pending: 2, stuck: 2 });
    const calls = fetchMock.mock.calls.length;
    await client.flush();
    expect(fetchMock.mock.calls.length).toBe(calls);

    fetchMock.mockImplementation(async (_url, init) =>
      json({
        results: JSON.parse(String(init?.body)).commands.map((c: { commandId: string }) =>
          result(c.commandId)
        ),
      })
    );
    const retried = await client.retry('good');
    expect(retried).toMatchObject({ sent: 1, completed: 1 });
    expect(client.getState()).toMatchObject({ pending: 1, stuck: 1 });
    await client.discard('bad');
    expect(client.getState()).toMatchObject({ pending: 0, stuck: 0 });
  });

  it('does not count network errors as server failures', async () => {
    const { client, fetchMock } = setup();
    await client.enqueue(command('n1'));
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    for (let i = 0; i < MAX_COMMAND_FAILURES + 2; i++) await client.flush();
    expect((await client.pending())[0]).toMatchObject({
      attempts: MAX_COMMAND_FAILURES + 2,
      failures: 0,
    });
    expect(client.getState().stuck).toBe(0);
  });

  it('lets the user discard a pending command', async () => {
    const { client } = setup();
    await client.enqueue(command('drop'));
    await client.discard('drop');
    expect(await client.pending()).toEqual([]);
    expect(client.getState().pending).toBe(0);
  });
});

describe('device id', () => {
  it('is generated once and kept in local storage', () => {
    const { client, kv } = setup();
    const id = client.deviceId();
    expect(id).toMatch(/^dev-/);
    expect(kv.get(DEVICE_ID_KEY)).toBe(id);
    expect(client.deviceId()).toBe(id);

    const other = createOfflineCommandClient({
      storage: createMemoryCommandStorage(),
      keyValue: { get: (key) => kv.get(key) ?? null, set: () => undefined },
    });
    expect(other.deviceId()).toBe(id);
  });

  it('still works when storage is blocked', () => {
    const { client } = setup({
      keyValue: {
        get: () => {
          throw new Error('SecurityError');
        },
        set: () => {
          throw new Error('SecurityError');
        },
      },
    });
    const id = client.deviceId();
    expect(id).toMatch(/^dev-/);
    expect(client.deviceId()).toBe(id);
  });
});

describe('automatic sync', () => {
  it('flushes on reconnection, when the tab becomes visible and every 30 seconds', async () => {
    vi.useFakeTimers();
    const { client } = setup();
    await client.enqueue(command('p'));
    const empty: FlushSummary = {
      sent: 0,
      completed: 0,
      rejected: 0,
      kept: 1,
      stoppedBy: null,
      results: [],
    };
    const flush = vi.spyOn(client, 'flush').mockResolvedValue(empty);
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as DocumentVisibilityState,
    });
    const targets = { window: win, document: doc } as unknown as SyncTargets;

    const stopA = client.start(targets);
    const stopB = client.start(targets);
    await vi.advanceTimersByTimeAsync(0);
    expect(flush).toHaveBeenCalledTimes(1); // something was pending at start

    win.dispatchEvent(new Event('offline'));
    expect(client.getState().online).toBe(false);
    win.dispatchEvent(new Event('online'));
    expect(client.getState().online).toBe(true);
    expect(flush).toHaveBeenCalledTimes(2);

    doc.dispatchEvent(new Event('visibilitychange'));
    expect(flush).toHaveBeenCalledTimes(3);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(flush).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(flush).toHaveBeenCalledTimes(4);

    stopA();
    win.dispatchEvent(new Event('online'));
    expect(flush).toHaveBeenCalledTimes(5); // still started by the second consumer
    stopB();
    stopB();
    win.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(flush).toHaveBeenCalledTimes(5);
  });
});

describe('withMemoryFallback', () => {
  const queued = (commandId: string, queuedAt: number): QueuedCommand => ({
    commandId,
    userId: 'u1',
    type: 'workitem.start',
    aggregate: { type: 'work_item', id: 'wi1' },
    payload: {},
    occurredAt: new Date(queuedAt).toISOString(),
    queuedAt,
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
  });

  it('keeps the known queue in memory once the primary storage fails', async () => {
    const broken: CommandQueueStorage = {
      list: vi
        .fn()
        .mockResolvedValueOnce([queued('old', 1)])
        .mockRejectedValue(new Error('blocked')),
      put: vi.fn().mockRejectedValue(new Error('QuotaExceededError')),
      remove: vi.fn(),
    };
    const onFallback = vi.fn();
    const storage = withMemoryFallback(broken, onFallback);

    expect((await storage.list()).map((c) => c.commandId)).toEqual(['old']);
    await storage.put(queued('new', 2));
    expect((await storage.list()).map((c) => c.commandId)).toEqual(['old', 'new']);
    await storage.remove(['old']);
    expect((await storage.list()).map((c) => c.commandId)).toEqual(['new']);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(broken.remove).not.toHaveBeenCalled();
  });
});
