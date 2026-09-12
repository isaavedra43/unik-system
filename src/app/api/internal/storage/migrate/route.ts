import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isInternalApiKeyValid } from '@/lib/internal-api-key';
import '@/modules/jobs/register-handlers';
import { enqueueJob, JOB_PRIORITY, waitForJob } from '@/modules/jobs/job-queue';
import { STORAGE_MIGRATE_JOB } from '@/modules/storage/storage-jobs';
import { getMigrationReport } from '@/modules/storage/storage-migration-service';

export const runtime = 'nodejs';
export const maxDuration = 300;

const bodySchema = z
  .object({
    mode: z.enum(['inventory', 'dry-run', 'copy', 'verify', 'reconcile']),
    batch_size: z.number().int().min(1).max(500).optional(),
    /** Wait up to N seconds for the job before returning (default 0 = return job id). */
    wait_seconds: z.number().int().min(0).max(280).optional(),
  })
  .strict();

/**
 * POST /api/internal/storage/migrate  (X-UNIK-API-Key)
 *
 * Enqueues one migration step (inventory → dry-run → copy → verify →
 * reconcile) as a durable job. Originals are never deleted. Used by
 * scripts/storage-migrate.mjs and by operators without UI access.
 */
export async function POST(request: Request) {
  if (!isInternalApiKeyValid(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body: unknown = {};
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const job = await enqueueJob({
    type: STORAGE_MIGRATE_JOB,
    payload: { mode: parsed.data.mode, batchSize: parsed.data.batch_size },
    priority: JOB_PRIORITY.maintenance,
    dedupeKey: `${STORAGE_MIGRATE_JOB}:${parsed.data.mode}`,
    maxAttempts: 1,
  });
  if (parsed.data.wait_seconds && parsed.data.wait_seconds > 0) {
    const finished = await waitForJob(job.id, parsed.data.wait_seconds * 1000, 1000);
    if (finished) {
      const report = await getMigrationReport();
      return NextResponse.json({
        status: finished.status,
        job_id: job.id,
        error: finished.lastError,
        result: finished.result,
        report_totals: report?.totals ?? null,
      });
    }
  }
  return NextResponse.json(
    { status: 'queued', job_id: job.id, deduplicated: job.deduplicated },
    { status: 202 }
  );
}

export async function GET(request: Request) {
  if (!isInternalApiKeyValid(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const report = await getMigrationReport();
  return NextResponse.json({
    report: report
      ? {
          mode: report.mode,
          startedAt: report.startedAt,
          updatedAt: report.updatedAt,
          totals: report.totals,
        }
      : null,
  });
}
