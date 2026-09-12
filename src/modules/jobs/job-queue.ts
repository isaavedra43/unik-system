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

export async function enqueueJob<P>(
  input: EnqueueInput<P>
): Promise<{ id: string; status: JobStatus; deduplicated: boolean }> {
  if (input.dedupeKey) {
    const existing = await prisma.backgroundJob.findUnique({
      where: { dedupeKey: input.dedupeKey },
    });
    if (existing && (existing.status === 'pending' || existing.status === 'running')) {
      return { id: existing.id, status: existing.status as JobStatus, deduplicated: true };
    }
    if (existing) {
      // Free the key so a new run can be scheduled.
      await prisma.backgroundJob.update({ where: { id: existing.id }, data: { dedupeKey: null } });
    }
  }
  const job = await prisma.backgroundJob.create({
    data: {
      type: input.type,
      payload: toJson(input.payload),
      priority: input.priority ?? JOB_PRIORITY.normal,
      runAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 3,
      dedupeKey: input.dedupeKey ?? null,
      groupKey: input.groupKey ?? null,
      createdBy: input.createdBy ?? null,
    },
  });
  wakeWorker();
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

function wakeWorker(): void {
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
            wakeWorker();
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
