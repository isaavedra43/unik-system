import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { randomUUID } from 'crypto';

/**
 * Durable background job queue backed by PostgreSQL.
 *
 * Producers call `enqueueJob`. One in-process worker per instance (started
 * from instrumentation.ts) claims jobs with `FOR UPDATE SKIP LOCKED`, so
 * several Railway instances can share the same table safely. Jobs survive
 * tab closes and restarts: a job locked by a dead instance is reclaimed
 * after `staleLockMs`.
 *
 * Priority: lower runs first. Interactive work (upload validation, document
 * export) uses < 100; bulk campaigns use >= 500 so human attention always
 * wins.
 *
 * The executor is deliberately behind this small API so a Redis/BullMQ
 * driver can replace it later without touching producers or handlers.
 */

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobContext<P = unknown> {
  id: string;
  type: string;
  payload: P;
  attempt: number;
  signal: AbortSignal;
  setProgress(percent: number): Promise<void>;
  log(message: string, extra?: Record<string, unknown>): void;
}

export type JobHandler<P = unknown, R = unknown> = (ctx: JobContext<P>) => Promise<R>;

interface HandlerEntry {
  handler: JobHandler;
  timeoutMs: number;
}

interface EnqueueInput<P> {
  type: string;
  payload: P;
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
  /** Idempotency key: an identical pending/running job is returned instead of a duplicate. */
  dedupeKey?: string;
  groupKey?: string;
  createdBy?: string;
  /**
   * Optional transaction client: the job row is created atomically with the
   * caller's writes and only becomes visible to the worker after the commit.
   * With a dedupeKey the insert uses ON CONFLICT DO NOTHING, so a concurrent
   * producer of the same key never aborts the caller's transaction. The worker
   * is not woken from inside the transaction: call `wakeJobWorker()` after the
   * commit, or the job waits for the next poll (1.5 s by default).
   */
  tx?: Prisma.TransactionClient;
}

const handlers = new Map<string, HandlerEntry>();

export const JOB_PRIORITY = {
  interactive: 10,
  normal: 100,
  maintenance: 300,
  bulk: 500,
} as const;

export function registerJobHandler<P = unknown, R = unknown>(
  type: string,
  handler: JobHandler<P, R>,
  options: { timeoutMs?: number } = {}
): void {
  handlers.set(type, {
    handler: handler as JobHandler,
    timeoutMs: options.timeoutMs ?? 10 * 60 * 1000,
  });
}

export function hasJobHandler(type: string): boolean {
  return handlers.has(type);
}

export function listJobTypes(): string[] {
  return [...handlers.keys()];
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return (value === undefined ? {} : JSON.parse(JSON.stringify(value))) as Prisma.InputJsonValue;
}

/** True when a Prisma error is the unique violation of `BackgroundJob.dedupeKey`. */
function isDedupeKeyConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  // Without target metadata the only unique besides the generated id is dedupeKey.
  if (target === undefined || target === null) return true;
  const fields = Array.isArray(target) ? target.map(String) : [String(target)];
  return fields.some((field) => field.includes('dedupeKey'));
}

type EnqueueResult = { id: string; status: JobStatus; deduplicated: boolean };

/**
 * Cross-instance brand: Next.js compiles a server module once per webpack
 * layer, so this file (and therefore the class below) exists several times in
 * the same process. A plain `instanceof` then returns false for an error thrown
 * by another copy — and the command engine would stop retrying the command,
 * turning an expected transient rejection into an unexpected HTTP 500 that the
 * offline queue retries forever. `Symbol.for` is process-wide, so the brand is
 * the same object in every copy. Same pattern as `OperationsError`,
 * `AuthorizationError` and `ConcurrencyConflict`.
 */
const JOB_DEDUPE_CONFLICT_BRAND: unique symbol = Symbol.for('unik.jobs.dedupeConflict');

/** Inside a transaction the dedupe key kept conflicting; the caller should retry its command. */
export class JobDedupeConflictError extends Error {
  readonly [JOB_DEDUPE_CONFLICT_BRAND] = true;
  readonly dedupeKey: string;

  constructor(dedupeKey: string) {
    super(`Could not enqueue job: dedupe key "${dedupeKey}" is still in conflict`);
    this.name = 'JobDedupeConflictError';
    this.dedupeKey = dedupeKey;
  }
}

/**
 * Use this instead of `instanceof JobDedupeConflictError`: it also recognises
 * the error when it was thrown by another compiled copy of this module (for
 * example an `enqueueJob({ tx })` inside a domain handler registered from a
 * different webpack layer).
 */
export function isJobDedupeConflictError(err: unknown): err is JobDedupeConflictError {
  if (err instanceof JobDedupeConflictError) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<symbol, unknown>)[JOB_DEDUPE_CONFLICT_BRAND] === true
  );
}

const TX_DEDUPE_ATTEMPTS = 2;

/**
 * Insert with a dedupe key inside the caller's transaction, without ever
 * raising a unique violation. In PostgreSQL a failed statement aborts the
 * whole transaction (every later statement fails with 25P02 and the commit
 * rolls everything back), so a P2002 cannot be caught and recovered from
 * inside `tx`. `createManyAndReturn({ skipDuplicates })` is
 * `INSERT … ON CONFLICT DO NOTHING RETURNING`: if another transaction holds an
 * uncommitted row with the same key, PostgreSQL waits for it to commit or roll
 * back and then inserts or skips. After a skip the winner is already committed
 * and, under READ COMMITTED (Prisma's default), visible to the next statement.
 */
async function insertDedupedInTransaction(
  tx: Prisma.TransactionClient,
  data: Prisma.BackgroundJobCreateManyInput,
  dedupeKey: string
): Promise<EnqueueResult> {
  for (let attempt = 0; attempt < TX_DEDUPE_ATTEMPTS; attempt++) {
    const [created] = await tx.backgroundJob.createManyAndReturn({
      data: [data],
      skipDuplicates: true,
      select: { id: true },
    });
    if (created) return { id: created.id, status: 'pending', deduplicated: false };
    const winner = await tx.backgroundJob.findUnique({ where: { dedupeKey } });
    if (winner) return { id: winner.id, status: winner.status as JobStatus, deduplicated: true };
    // The winner finished and released its key between both statements: insert again.
  }
  throw new JobDedupeConflictError(dedupeKey);
}

export async function enqueueJob<P>(input: EnqueueInput<P>): Promise<EnqueueResult> {
  const db = input.tx ?? prisma;
  const data: Prisma.BackgroundJobCreateManyInput = {
    type: input.type,
    payload: toJson(input.payload),
    priority: input.priority ?? JOB_PRIORITY.normal,
    runAt: input.runAt ?? new Date(),
    maxAttempts: input.maxAttempts ?? 3,
    dedupeKey: input.dedupeKey ?? null,
    groupKey: input.groupKey ?? null,
    createdBy: input.createdBy ?? null,
  };
  if (input.dedupeKey) {
    const existing = await db.backgroundJob.findUnique({
      where: { dedupeKey: input.dedupeKey },
    });
    if (existing && (existing.status === 'pending' || existing.status === 'running')) {
      return { id: existing.id, status: existing.status as JobStatus, deduplicated: true };
    }
    if (existing) {
      // Free the key so a new run can be scheduled.
      await db.backgroundJob.update({ where: { id: existing.id }, data: { dedupeKey: null } });
    }
  }

  if (input.tx) {
    // The worker cannot see the row before the caller commits, so it is not woken
    // here: the caller runs wakeJobWorker() after the commit.
    if (!input.dedupeKey) {
      const job = await input.tx.backgroundJob.create({ data });
      return { id: job.id, status: 'pending', deduplicated: false };
    }
    return insertDedupedInTransaction(input.tx, data, input.dedupeKey);
  }

  let job: { id: string };
  try {
    job = await prisma.backgroundJob.create({ data });
  } catch (err) {
    if (!input.dedupeKey || !isDedupeKeyConflict(err)) throw err;
    // Outside a transaction the failed INSERT aborts nothing: a concurrent
    // producer committed the same key between the lookup and the insert, so its
    // job is returned.
    const winner = await prisma.backgroundJob.findUnique({
      where: { dedupeKey: input.dedupeKey },
    });
    if (!winner) throw err;
    return { id: winner.id, status: winner.status as JobStatus, deduplicated: true };
  }
  wakeJobWorker();
  return { id: job.id, status: 'pending', deduplicated: false };
}

export async function getJob(id: string) {
  return prisma.backgroundJob.findUnique({ where: { id } });
}

export async function cancelJob(id: string): Promise<boolean> {
  const res = await prisma.backgroundJob.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'cancelled', completedAt: new Date(), dedupeKey: null },
  });
  return res.count > 0;
}

/** Cancels every pending job of a group (e.g. a suspended plugin or a stopped campaign). */
export async function cancelJobsByGroup(groupKey: string): Promise<number> {
  const res = await prisma.backgroundJob.updateMany({
    where: { groupKey, status: 'pending' },
    data: { status: 'cancelled', completedAt: new Date(), dedupeKey: null },
  });
  // Running jobs of the group are asked to stop cooperatively.
  for (const [jobId, controller] of runningControllers) {
    if (runningGroups.get(jobId) === groupKey) controller.abort();
  }
  return res.count;
}

/** Waits (polling) for a job to reach a terminal state. Returns null on timeout. */
export async function waitForJob(id: string, timeoutMs: number, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await prisma.backgroundJob.findUnique({ where: { id } });
    if (!job) return null;
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')
      return job;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

interface WorkerState {
  started: boolean;
  workerId: string;
  active: number;
  wake: (() => void) | null;
  stopped: boolean;
}

type GlobalWithWorker = typeof globalThis & { __unikJobWorker?: WorkerState };

function getWorkerState(): WorkerState {
  const scope = globalThis as GlobalWithWorker;
  scope.__unikJobWorker ??= {
    started: false,
    workerId: `${process.pid}-${randomUUID().slice(0, 8)}`,
    active: 0,
    wake: null,
    stopped: false,
  };
  return scope.__unikJobWorker;
}

const runningControllers = new Map<string, AbortController>();
const runningGroups = new Map<string, string>();

/**
 * Wakes this process's worker if it is waiting for work. `enqueueJob` calls it
 * by itself outside a transaction; a producer that passed `tx` calls it after
 * the commit (before that the worker cannot see the row). Without the call the
 * job still runs on the next poll.
 */
export function wakeJobWorker(): void {
  const state = getWorkerState();
  state.wake?.();
}

function log(payload: Record<string, unknown>): void {
  console.info(JSON.stringify({ component: 'jobs', ...payload }));
}

interface ClaimedJob {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  groupKey: string | null;
}

async function claimNextJob(workerId: string, types: string[]): Promise<ClaimedJob | null> {
  if (types.length === 0) return null;
  const rows = await prisma.$queryRaw<ClaimedJob[]>`
    UPDATE "BackgroundJob"
    SET "status" = 'running', "lockedAt" = NOW(), "lockedBy" = ${workerId}, "attempts" = "attempts" + 1, "updatedAt" = NOW()
    WHERE "id" = (
      SELECT "id" FROM "BackgroundJob"
      WHERE "status" = 'pending' AND "runAt" <= NOW() AND "type" IN (${Prisma.join(types)})
      ORDER BY "priority" ASC, "runAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "type", "payload", "attempts", "maxAttempts", "groupKey"
  `;
  return rows[0] ?? null;
}

async function reclaimStaleJobs(staleLockMs: number): Promise<void> {
  const cutoff = new Date(Date.now() - staleLockMs);
  const res = await prisma.backgroundJob.updateMany({
    where: { status: 'running', lockedAt: { lt: cutoff } },
    data: { status: 'pending', lockedAt: null, lockedBy: null },
  });
  if (res.count > 0) log({ event: 'jobs_reclaimed', count: res.count });
}

async function runJob(job: ClaimedJob, entry: HandlerEntry): Promise<void> {
  const controller = new AbortController();
  runningControllers.set(job.id, controller);
  if (job.groupKey) runningGroups.set(job.id, job.groupKey);
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), entry.timeoutMs);
  const ctx: JobContext = {
    id: job.id,
    type: job.type,
    payload: job.payload,
    attempt: job.attempts,
    signal: controller.signal,
    async setProgress(percent) {
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: { progress: Math.max(0, Math.min(100, Math.round(percent))) },
      });
    },
    log(message, extra) {
      log({ event: 'job_log', jobId: job.id, type: job.type, message, ...extra });
    },
  };
  try {
    const result = await entry.handler(ctx);
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        progress: 100,
        result: result === undefined ? Prisma.JsonNull : toJson(result),
        lockedAt: null,
        lockedBy: null,
        dedupeKey: null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = job.attempts >= job.maxAttempts || controller.signal.aborted;
    const backoffMs = Math.min(60_000 * job.attempts, 15 * 60_000);
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: exhausted
        ? {
            status: 'failed',
            lastError: message.slice(0, 2000),
            completedAt: new Date(),
            lockedAt: null,
            lockedBy: null,
            dedupeKey: null,
          }
        : {
            status: 'pending',
            lastError: message.slice(0, 2000),
            runAt: new Date(Date.now() + backoffMs),
            lockedAt: null,
            lockedBy: null,
          },
    });
    log({
      event: 'job_failed',
      jobId: job.id,
      type: job.type,
      attempt: job.attempts,
      exhausted,
      error: message,
    });
  } finally {
    clearTimeout(timeout);
    runningControllers.delete(job.id);
    runningGroups.delete(job.id);
  }
}

export interface JobWorkerOptions {
  pollMs?: number;
  concurrency?: number;
  staleLockMs?: number;
}

/**
 * Starts the worker loop once per process. Safe to call multiple times.
 * Skipped during `next build` and when explicitly disabled.
 */
export function startJobWorker(options: JobWorkerOptions = {}): void {
  const state = getWorkerState();
  if (state.started) return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (process.env.UNIK_JOB_WORKER_ENABLED === 'false') return;
  state.started = true;

  const pollMs = options.pollMs ?? 1500;
  const concurrency = options.concurrency ?? 2;
  const staleLockMs = options.staleLockMs ?? 15 * 60 * 1000;
  let lastReclaim = 0;

  const loop = async () => {
    log({ event: 'job_worker_started', workerId: state.workerId, concurrency });
    while (!state.stopped) {
      try {
        if (Date.now() - lastReclaim > 60_000) {
          lastReclaim = Date.now();
          await reclaimStaleJobs(staleLockMs);
        }
        let claimed = false;
        while (state.active < concurrency) {
          const job = await claimNextJob(state.workerId, listJobTypes());
          if (!job) break;
          const entry = handlers.get(job.type);
          if (!entry) {
            await prisma.backgroundJob.update({
              where: { id: job.id },
              data: {
                status: 'failed',
                lastError: 'No handler registered',
                completedAt: new Date(),
              },
            });
            continue;
          }
          claimed = true;
          state.active++;
          void runJob(job, entry).finally(() => {
            state.active--;
            wakeJobWorker();
          });
        }
        if (!claimed) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              state.wake = null;
              resolve();
            }, pollMs);
            state.wake = () => {
              clearTimeout(timer);
              state.wake = null;
              resolve();
            };
          });
        }
      } catch (err) {
        log({ event: 'job_worker_error', error: err instanceof Error ? err.message : String(err) });
        await new Promise((r) => setTimeout(r, pollMs * 2));
      }
    }
  };
  void loop();
}

/** Test/shutdown helper. */
export function stopJobWorker(): void {
  const state = getWorkerState();
  state.stopped = true;
  state.wake?.();
}

/** Admin listing. */
export async function listJobs(
  filters: { status?: JobStatus; type?: string; limit?: number } = {}
) {
  return prisma.backgroundJob.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.type ? { type: filters.type } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(filters.limit ?? 50, 200),
  });
}

export async function getJobStats(): Promise<Record<JobStatus, number>> {
  const groups = await prisma.backgroundJob.groupBy({ by: ['status'], _count: { _all: true } });
  const stats: Record<JobStatus, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const g of groups) stats[g.status as JobStatus] = g._count._all;
  return stats;
}
