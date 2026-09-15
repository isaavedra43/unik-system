/**
 * Offline-first client for operational commands (plan section 2.2).
 *
 * `submitCommand(cmd)` sends a command right away when the device is online;
 * when it is offline, the network fails, the server is unavailable or the
 * session expired, the command is kept in IndexedDB (`unik-commands`) and sent
 * later in batches of up to 50 to `POST /app/operations/api/commands/batch`.
 * The queue is flushed when the browser comes back online, when the tab
 * becomes visible and every 30 seconds while something is pending.
 *
 * Every command carries a client-generated `commandId`, so sending it twice
 * (a retry after a lost response, two tabs flushing) never applies it twice:
 * the server replays the stored result. The device id lives in localStorage
 * and tags every batch. No dependencies: IndexedDB is used directly, with an
 * in-memory fallback when it is unavailable (private browsing, old WebViews).
 *
 * The queue is per device but every command belongs to the user who created
 * it (`userId`, given by the server layout through `setUserId`). A flush only
 * sends the commands of the signed-in user, and the batch carries that id: the
 * server answers `actor_mismatch` without executing anything when the session
 * belongs to someone else, and the client keeps those commands. On a shared
 * phone or tablet the work of one person is never sent (or lost) under
 * another person's session; it waits, visible as "pendiente de otro usuario".
 *
 * A batch the server refuses as too large (413) is split in halves down to a
 * single command, which is then rejected locally. A command the server keeps
 * answering `failed` stops being sent automatically after
 * `MAX_COMMAND_FAILURES`: the UI offers `retry` or `discard`.
 *
 * `createOfflineCommandClient(options)` accepts injectable storage, fetch,
 * clock and connectivity, which is how it is tested outside a browser.
 */

export const COMMANDS_ENDPOINT = '/app/operations/api/commands';
export const COMMANDS_BATCH_ENDPOINT = '/app/operations/api/commands/batch';
export const OFFLINE_DB_NAME = 'unik-commands';
export const OFFLINE_STORE_NAME = 'commands';
export const DEVICE_ID_KEY = 'unik-device-id';
export const MAX_BATCH_SIZE = 50;
export const FLUSH_INTERVAL_MS = 30_000;
/** Server `failed` answers after which a command waits for the user (retry or discard). */
export const MAX_COMMAND_FAILURES = 20;
/** Result code of the server when the batch user is not the session user. */
export const ACTOR_MISMATCH_CODE = 'actor_mismatch';
/** Local rejection of a single command larger than the server accepts. */
export const PAYLOAD_TOO_LARGE_CODE = 'payload_too_large';

export interface CommandAggregateRef {
  type: string;
  id: string;
}

export interface OfflineCommandInput<P = unknown> {
  type: string;
  aggregate: CommandAggregateRef;
  payload: P;
  expectedVersion?: number;
  /** Reuse an id to retry the same intent; generated when omitted. */
  commandId?: string;
  /** When it happened on the device (ISO); defaults to now. */
  occurredAt?: string;
}

export interface QueuedCommand {
  commandId: string;
  /** Session user who created the command; only that user's session sends it. */
  userId: string | null;
  type: string;
  aggregate: CommandAggregateRef;
  payload: unknown;
  expectedVersion?: number;
  occurredAt: string;
  queuedAt: number;
  attempts: number;
  /** Times the server answered `failed` (or nothing) for this command; network errors do not count. */
  failures?: number;
  lastError: string | null;
  lastAttemptAt: number | null;
}

export type ClientCommandStatus =
  'completed' | 'pending_external' | 'accepted' | 'rejected' | 'failed';

export interface ClientCommandResult<D = unknown> {
  commandId: string;
  type: string;
  status: ClientCommandStatus;
  errorCode?: string;
  message?: string;
  aggregateVersion: number;
  emittedEventIds: string[];
  createdWorkItemIds: string[];
  externalSyncStatus?: string;
  data?: D;
  replayed?: boolean;
  httpStatus?: number;
}

export type QueueReason =
  | 'offline'
  | 'network'
  | 'server'
  | 'unauthenticated'
  /** The server is still running the same commandId: the next flush reads its final result. */
  | 'in_flight'
  /** The session belongs to another user than the one who created the command. */
  | 'actor_mismatch';

export type SubmitOutcome<D = unknown> =
  | { queued: false; commandId: string; result: ClientCommandResult<D> }
  | { queued: true; commandId: string; reason: QueueReason };

export interface FlushSummary {
  sent: number;
  completed: number;
  rejected: number;
  kept: number;
  stoppedBy: QueueReason | null;
  results: ClientCommandResult[];
}

export interface OfflineQueueState {
  /** Signed-in user whose commands this page sends. */
  userId: string | null;
  /** Pending commands of the signed-in user. */
  pending: number;
  /** Commands created on this device by other users (sent when they sign in again). */
  pendingOtherUsers: number;
  /** Commands of the signed-in user that reached `MAX_COMMAND_FAILURES` (retry or discard). */
  stuck: number;
  online: boolean;
  flushing: boolean;
  lastFlushAt: number | null;
  lastError: string | null;
  /** Final results of the last flush (rejections are what the UI should show). */
  lastResults: ClientCommandResult[];
}

export interface CommandQueueStorage {
  list(): Promise<QueuedCommand[]>;
  put(command: QueuedCommand): Promise<void>;
  remove(commandIds: string[]): Promise<void>;
}

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Minimal event target used by `start()` (window and document in the browser). */
export interface SyncTargets {
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  document?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}

export interface OfflineCommandClientOptions {
  /** Signed-in user (can be set later with `setUserId`). */
  userId?: string | null;
  storage?: CommandQueueStorage;
  fetch?: typeof fetch;
  endpoint?: string;
  batchEndpoint?: string;
  isOnline?: () => boolean;
  now?: () => number;
  randomId?: () => string;
  keyValue?: KeyValueStore;
  batchSize?: number;
  flushIntervalMs?: number;
  maxFailures?: number;
}

export interface OfflineCommandClient {
  deviceId(): string;
  /** Session user of the page (from the server layout); null after signing out. */
  setUserId(userId: string | null): void;
  /** Throws when no user is set: a command must always know who created it. */
  submit<P = unknown, D = unknown>(input: OfflineCommandInput<P>): Promise<SubmitOutcome<D>>;
  enqueue<P = unknown>(input: OfflineCommandInput<P>): Promise<QueuedCommand>;
  flush(): Promise<FlushSummary>;
  /** Every queued command of the device (compare `userId` to tell other users' work apart). */
  pending(): Promise<QueuedCommand[]>;
  discard(commandId: string): Promise<void>;
  /** Clears the failure count of a stuck command and sends it again. */
  retry(commandId: string): Promise<FlushSummary>;
  getState(): OfflineQueueState;
  subscribe(listener: () => void): () => void;
  /** Starts automatic flushing; returns the stop function. Safe to call from several components. */
  start(targets?: SyncTargets): () => void;
}

// ---------------------------------------------------------------------------
// Storage adapters
// ---------------------------------------------------------------------------

const byQueueOrder = (a: QueuedCommand, b: QueuedCommand) =>
  a.queuedAt - b.queuedAt || a.commandId.localeCompare(b.commandId);

export function createMemoryCommandStorage(initial: QueuedCommand[] = []): CommandQueueStorage {
  const rows = new Map(initial.map((c) => [c.commandId, { ...c }]));
  return {
    async list() {
      return [...rows.values()].map((c) => ({ ...c })).sort(byQueueOrder);
    },
    async put(command) {
      rows.set(command.commandId, { ...command });
    },
    async remove(commandIds) {
      for (const id of commandIds) rows.delete(id);
    },
  };
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

/** IndexedDB `unik-commands` → store `commands` (keyPath commandId, index queuedAt). */
export function createIndexedDbCommandStorage(
  factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB
): CommandQueueStorage {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const open = () => {
    if (!factory) return Promise.reject(new Error('IndexedDB no está disponible'));
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(OFFLINE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(OFFLINE_STORE_NAME)) {
          const store = db.createObjectStore(OFFLINE_STORE_NAME, { keyPath: 'commandId' });
          store.createIndex('queuedAt', 'queuedAt');
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('No se pudo abrir IndexedDB'));
      request.onblocked = () => reject(new Error('IndexedDB está bloqueado por otra pestaña'));
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
    return dbPromise;
  };
  return {
    async list() {
      const db = await open();
      const tx = db.transaction(OFFLINE_STORE_NAME, 'readonly');
      const rows = await requestToPromise(
        tx.objectStore(OFFLINE_STORE_NAME).getAll() as IDBRequest<QueuedCommand[]>
      );
      return rows.sort(byQueueOrder);
    },
    async put(command) {
      const db = await open();
      const tx = db.transaction(OFFLINE_STORE_NAME, 'readwrite');
      tx.objectStore(OFFLINE_STORE_NAME).put(command);
      await transactionDone(tx);
    },
    async remove(commandIds) {
      if (commandIds.length === 0) return;
      const db = await open();
      const tx = db.transaction(OFFLINE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(OFFLINE_STORE_NAME);
      for (const id of commandIds) store.delete(id);
      await transactionDone(tx);
    },
  };
}

/**
 * Uses `primary` until it fails once, then keeps working in memory (the
 * pending commands read so far are carried over) and reports it once.
 */
export function withMemoryFallback(
  primary: CommandQueueStorage,
  onFallback: (error: unknown) => void = () => undefined
): CommandQueueStorage {
  const memory = createMemoryCommandStorage();
  let active = primary;
  let lastKnown: QueuedCommand[] = [];
  const guard = async <T>(run: (storage: CommandQueueStorage) => Promise<T>): Promise<T> => {
    if (active === memory) return run(memory);
    try {
      return await run(active);
    } catch (error) {
      active = memory;
      for (const command of lastKnown) await memory.put(command);
      onFallback(error);
      return run(memory);
    }
  };
  return {
    list: () =>
      guard(async (storage) => {
        const rows = await storage.list();
        if (storage !== memory) lastKnown = rows;
        return rows;
      }),
    put: (command) =>
      guard(async (storage) => {
        await storage.put(command);
        if (storage !== memory) {
          lastKnown = [...lastKnown.filter((c) => c.commandId !== command.commandId), command];
        }
      }),
    remove: (ids) =>
      guard(async (storage) => {
        await storage.remove(ids);
        if (storage !== memory) lastKnown = lastKnown.filter((c) => !ids.includes(c.commandId));
      }),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const FINAL_STATUSES: readonly ClientCommandStatus[] = [
  'completed',
  'pending_external',
  'rejected',
];

/** Final for the queue: `actor_mismatch` is a rejection of the session, not of the command. */
function isFinalResult(result: ClientCommandResult): boolean {
  return FINAL_STATUSES.includes(result.status) && result.errorCode !== ACTOR_MISMATCH_CODE;
}

function defaultRandomId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function browserKeyValue(): KeyValueStore {
  const memory = new Map<string, string>();
  return {
    get(key) {
      try {
        return globalThis.localStorage?.getItem(key) ?? memory.get(key) ?? null;
      } catch {
        return memory.get(key) ?? null;
      }
    },
    set(key, value) {
      memory.set(key, value);
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        // Storage disabled: the id lives for this page only.
      }
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeUserId(userId: string | null | undefined): string | null {
  const text = typeof userId === 'string' ? userId.trim() : '';
  return text || null;
}

export function createOfflineCommandClient(
  options: OfflineCommandClientOptions = {}
): OfflineCommandClient {
  const storage = options.storage ?? createMemoryCommandStorage();
  const fetchImpl: typeof fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const endpoint = options.endpoint ?? COMMANDS_ENDPOINT;
  const batchEndpoint = options.batchEndpoint ?? COMMANDS_BATCH_ENDPOINT;
  const isOnline =
    options.isOnline ??
    (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const now = options.now ?? (() => Date.now());
  const randomId = options.randomId ?? defaultRandomId;
  const keyValue = options.keyValue ?? browserKeyValue();
  const batchSize = Math.min(Math.max(1, options.batchSize ?? MAX_BATCH_SIZE), MAX_BATCH_SIZE);
  const flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const maxFailures = Math.max(1, options.maxFailures ?? MAX_COMMAND_FAILURES);

  let currentUserId = normalizeUserId(options.userId);
  let state: OfflineQueueState = {
    userId: currentUserId,
    pending: 0,
    pendingOtherUsers: 0,
    stuck: 0,
    online: isOnline(),
    flushing: false,
    lastFlushAt: null,
    lastError: null,
    lastResults: [],
  };
  const listeners = new Set<() => void>();
  let flushing: Promise<FlushSummary> | null = null;
  let cachedDeviceId: string | null = null;
  let started = 0;
  let stopSync: (() => void) | null = null;

  const setState = (patch: Partial<OfflineQueueState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const isStuck = (command: QueuedCommand) => (command.failures ?? 0) >= maxFailures;
  const ownedByCurrentUser = (command: QueuedCommand) =>
    currentUserId !== null && command.userId === currentUserId;

  /** Recounts the queue; returns the commands of the signed-in user. */
  const refreshPending = async (): Promise<QueuedCommand[]> => {
    try {
      const rows = await storage.list();
      const own = rows.filter(ownedByCurrentUser);
      const counts = {
        pending: own.length,
        pendingOtherUsers: rows.length - own.length,
        stuck: own.filter(isStuck).length,
      };
      if (
        counts.pending !== state.pending ||
        counts.pendingOtherUsers !== state.pendingOtherUsers ||
        counts.stuck !== state.stuck
      ) {
        setState(counts);
      }
      return own;
    } catch (error) {
      setState({ lastError: errorText(error) });
      return [];
    }
  };

  const deviceId = () => {
    if (cachedDeviceId) return cachedDeviceId;
    let id: string | null = null;
    try {
      id = keyValue.get(DEVICE_ID_KEY);
    } catch {
      id = null;
    }
    if (!id) {
      id = `dev-${randomId()}`;
      try {
        keyValue.set(DEVICE_ID_KEY, id);
      } catch {
        // Kept in memory for this session.
      }
    }
    cachedDeviceId = id;
    return id;
  };

  const requireUserId = (): string => {
    if (!currentUserId) {
      throw new Error('No hay una sesión de usuario para registrar la acción; inicia sesión');
    }
    return currentUserId;
  };

  const materialize = <P>(input: OfflineCommandInput<P>): QueuedCommand => ({
    commandId: input.commandId ?? randomId(),
    userId: requireUserId(),
    type: input.type,
    aggregate: { type: input.aggregate.type, id: input.aggregate.id },
    payload: input.payload ?? {},
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    occurredAt: input.occurredAt ?? new Date(now()).toISOString(),
    queuedAt: now(),
    attempts: 0,
    failures: 0,
    lastError: null,
    lastAttemptAt: null,
  });

  const toWire = (command: QueuedCommand) => ({
    commandId: command.commandId,
    type: command.type,
    aggregate: command.aggregate,
    payload: command.payload,
    ...(command.expectedVersion !== undefined ? { expectedVersion: command.expectedVersion } : {}),
    occurredAt: command.occurredAt,
  });

  const store = async (command: QueuedCommand, reason: QueueReason, error?: string) => {
    await storage.put({ ...command, lastError: error ?? reason });
    await refreshPending();
    setState({ lastError: error ?? null, online: isOnline() });
  };

  const post = (url: string, body: unknown) =>
    fetchImpl(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const retryable = (status: number) => status >= 500 || status === 408 || status === 429;

  const localRejection = (
    command: QueuedCommand,
    errorCode: string,
    message: string,
    httpStatus: number
  ): ClientCommandResult => ({
    commandId: command.commandId,
    type: command.type,
    status: 'rejected',
    errorCode,
    message,
    aggregateVersion: 0,
    emittedEventIds: [],
    createdWorkItemIds: [],
    httpStatus,
  });

  const client: OfflineCommandClient = {
    deviceId,

    setUserId(userId) {
      const next = normalizeUserId(userId);
      if (next === currentUserId) return;
      currentUserId = next;
      setState({ userId: next, lastResults: [], lastError: null });
      void refreshPending().then((own) => {
        if (started > 0 && own.some((c) => !isStuck(c))) void client.flush();
      });
    },

    async enqueue(input) {
      const command = materialize(input);
      await storage.put(command);
      await refreshPending();
      return command;
    },

    async submit<P, D>(input: OfflineCommandInput<P>): Promise<SubmitOutcome<D>> {
      const command = materialize(input);
      if (!isOnline()) {
        await store(command, 'offline');
        return { queued: true, commandId: command.commandId, reason: 'offline' };
      }
      let response: Response;
      try {
        response = await post(endpoint, {
          ...toWire(command),
          deviceId: deviceId(),
          userId: command.userId,
        });
      } catch (error) {
        await store(command, 'network', errorText(error));
        return { queued: true, commandId: command.commandId, reason: 'network' };
      }
      if (response.status === 401) {
        await store(command, 'unauthenticated', 'Sesión expirada');
        return { queued: true, commandId: command.commandId, reason: 'unauthenticated' };
      }
      const body = (await response.json().catch(() => null)) as {
        result?: ClientCommandResult<D>;
      } | null;
      if (retryable(response.status) || !body?.result) {
        await store(command, 'server', `HTTP ${response.status}`);
        return { queued: true, commandId: command.commandId, reason: 'server' };
      }
      if (body.result.errorCode === ACTOR_MISMATCH_CODE) {
        await store(command, 'actor_mismatch', body.result.message ?? 'Sesión de otro usuario');
        return { queued: true, commandId: command.commandId, reason: 'actor_mismatch' };
      }
      if (body.result.status === 'accepted') {
        // The same commandId is still running on the server (double tap, retry):
        // keep it so the next flush reads the final result instead of losing it.
        await store(command, 'in_flight', 'En curso en el servidor');
        return { queued: true, commandId: command.commandId, reason: 'in_flight' };
      }
      return {
        queued: false,
        commandId: command.commandId,
        result: { ...body.result, httpStatus: response.status },
      };
    },

    flush() {
      if (flushing) return flushing;
      flushing = (async (): Promise<FlushSummary> => {
        const summary: FlushSummary = {
          sent: 0,
          completed: 0,
          rejected: 0,
          kept: 0,
          stoppedBy: null,
          results: [],
        };
        const online = isOnline();
        if (!online) {
          summary.stoppedBy = 'offline';
          summary.kept = (await refreshPending()).length;
          setState({ online: false });
          return summary;
        }
        const userId = currentUserId;
        if (!userId) {
          summary.stoppedBy = 'unauthenticated';
          summary.kept = (await refreshPending()).length;
          return summary;
        }
        setState({ flushing: true, online: true });
        let lastError: string | null = null;
        try {
          // Only the signed-in user's commands, and never the ones waiting for the user.
          const queue = (await storage.list()).filter(
            (command) => command.userId === userId && !isStuck(command)
          );
          const chunks: QueuedCommand[][] = [];
          for (let i = 0; i < queue.length; i += batchSize) {
            chunks.push(queue.slice(i, i + batchSize));
          }
          while (chunks.length > 0 && !summary.stoppedBy) {
            const chunk = chunks.shift()!;
            const attemptAt = now();
            const markAttempt = async (
              commands: QueuedCommand[],
              error: string,
              countsAsFailure: boolean
            ) => {
              for (const command of commands) {
                await storage.put({
                  ...command,
                  attempts: command.attempts + 1,
                  failures: (command.failures ?? 0) + (countsAsFailure ? 1 : 0),
                  lastAttemptAt: attemptAt,
                  lastError: error,
                });
              }
            };
            let response: Response;
            try {
              response = await post(batchEndpoint, {
                deviceId: deviceId(),
                userId,
                commands: chunk.map(toWire),
              });
            } catch (error) {
              lastError = errorText(error);
              await markAttempt(chunk, lastError, false);
              summary.stoppedBy = 'network';
              break;
            }
            if (response.status === 401) {
              lastError = 'Sesión expirada';
              summary.stoppedBy = 'unauthenticated';
              break;
            }
            if (response.status === 413) {
              if (chunk.length > 1) {
                // Too large for one request: send it again in halves, keeping the order.
                const half = Math.ceil(chunk.length / 2);
                chunks.unshift(chunk.slice(0, half), chunk.slice(half));
                continue;
              }
              const [command] = chunk;
              const rejected = localRejection(
                command,
                PAYLOAD_TOO_LARGE_CODE,
                'La acción es demasiado grande para enviarse; revisa los datos y regístrala de nuevo',
                413
              );
              summary.results.push(rejected);
              summary.rejected += 1;
              await storage.remove([command.commandId]);
              continue;
            }
            const body = (await response.json().catch(() => null)) as {
              results?: ClientCommandResult[];
            } | null;
            if (!response.ok || !Array.isArray(body?.results)) {
              lastError = `HTTP ${response.status}`;
              await markAttempt(chunk, lastError, false);
              summary.stoppedBy = 'server';
              break;
            }
            const byId = new Map(body.results.map((r) => [r.commandId, r]));
            if (chunk.some((c) => byId.get(c.commandId)?.errorCode === ACTOR_MISMATCH_CODE)) {
              // The session is someone else's: nothing ran and nothing is lost.
              lastError = byId.get(chunk[0].commandId)?.message ?? 'La sesión es de otro usuario';
              summary.stoppedBy = 'actor_mismatch';
              break;
            }
            summary.sent += chunk.length;
            const done: string[] = [];
            for (const command of chunk) {
              const result = byId.get(command.commandId);
              if (result && isFinalResult(result)) {
                done.push(command.commandId);
                summary.results.push(result);
                if (result.status === 'rejected') summary.rejected += 1;
                else summary.completed += 1;
                continue;
              }
              if (result?.status === 'accepted') continue; // still running elsewhere
              await markAttempt(
                [command],
                result?.message ?? result?.errorCode ?? 'Sin respuesta para este comando',
                true
              );
            }
            await storage.remove(done);
          }
        } catch (error) {
          lastError = errorText(error);
        } finally {
          const remaining = await refreshPending();
          summary.kept = remaining.length;
          setState({
            flushing: false,
            lastFlushAt: now(),
            lastError,
            lastResults: summary.results.length > 0 ? summary.results : state.lastResults,
          });
        }
        return summary;
      })().finally(() => {
        flushing = null;
      });
      return flushing;
    },

    pending: () => storage.list(),

    async discard(commandId) {
      await storage.remove([commandId]);
      await refreshPending();
    },

    async retry(commandId) {
      const command = (await storage.list()).find((c) => c.commandId === commandId);
      if (command) {
        await storage.put({ ...command, failures: 0, lastError: null });
        await refreshPending();
      }
      return client.flush();
    },

    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start(targets) {
      started += 1;
      if (started === 1) {
        const win =
          targets?.window ?? (typeof window === 'undefined' ? undefined : (window as Window));
        const doc =
          targets?.document ??
          (typeof document === 'undefined' ? undefined : (document as Document));
        const flushSoon = () => {
          void client.flush();
        };
        const onOnline = () => {
          setState({ online: true });
          flushSoon();
        };
        const onOffline = () => setState({ online: false });
        const onVisibility = () => {
          if (doc?.visibilityState === 'visible') flushSoon();
        };
        win?.addEventListener('online', onOnline);
        win?.addEventListener('offline', onOffline);
        doc?.addEventListener('visibilitychange', onVisibility);
        const timer = setInterval(() => {
          if (state.pending > state.stuck) flushSoon();
        }, flushIntervalMs);
        void refreshPending().then((rows) => {
          if (rows.some((c) => !isStuck(c))) flushSoon();
        });
        stopSync = () => {
          win?.removeEventListener('online', onOnline);
          win?.removeEventListener('offline', onOffline);
          doc?.removeEventListener('visibilitychange', onVisibility);
          clearInterval(timer);
        };
      }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        started -= 1;
        if (started === 0) {
          stopSync?.();
          stopSync = null;
        }
      };
    },
  };
  return client;
}

// ---------------------------------------------------------------------------
// Browser singleton
// ---------------------------------------------------------------------------

type GlobalWithClient = typeof globalThis & { __unikOfflineCommandClient?: OfflineCommandClient };

/** The shared client of this page (IndexedDB with in-memory fallback). */
export function getOfflineCommandClient(): OfflineCommandClient {
  const scope = globalThis as GlobalWithClient;
  if (!scope.__unikOfflineCommandClient) {
    const hasIndexedDb = typeof indexedDB !== 'undefined';
    scope.__unikOfflineCommandClient = createOfflineCommandClient({
      storage: hasIndexedDb
        ? withMemoryFallback(createIndexedDbCommandStorage(), (error) =>
            console.warn(
              JSON.stringify({
                component: 'offline-commands',
                event: 'indexeddb_unavailable',
                message: errorText(error),
              })
            )
          )
        : createMemoryCommandStorage(),
    });
  }
  return scope.__unikOfflineCommandClient;
}

/** Sends now or queues for later (see the module comment). */
export function submitCommand<P = unknown, D = unknown>(
  input: OfflineCommandInput<P>
): Promise<SubmitOutcome<D>> {
  return getOfflineCommandClient().submit<P, D>(input);
}

export function flushCommandQueue(): Promise<FlushSummary> {
  return getOfflineCommandClient().flush();
}

export function startOfflineCommandSync(): () => void {
  return getOfflineCommandClient().start();
}

/** Tells the shared client who is signed in (the server layout knows it). */
export function setOfflineCommandUser(userId: string | null): void {
  getOfflineCommandClient().setUserId(userId);
}

export function getDeviceId(): string {
  return getOfflineCommandClient().deviceId();
}
