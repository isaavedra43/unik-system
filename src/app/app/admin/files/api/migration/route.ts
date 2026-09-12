import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireFilesAdmin } from '../_auth';
import { enqueueJob, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { STORAGE_MIGRATE_JOB } from '@/modules/storage/storage-jobs';
import { getMigrationReport } from '@/modules/storage/storage-migration-service';
import { recordAuditEvent } from '@/modules/auth/audit-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const runSchema = z.object({
  mode: z.enum(['inventory', 'dry-run', 'copy', 'verify', 'reconcile']),
  batchSize: z.number().int().min(1).max(500).optional(),
});

/** GET → current migration report (without the per-file entries, which can be large). */
export async function GET(request: NextRequest) {
  const auth = await requireFilesAdmin();
  if ('response' in auth) return auth.response;
  const report = await getMigrationReport();
  if (!report) return NextResponse.json({ report: null });
  const includeEntries = request.nextUrl.searchParams.get('entries') === '1';
  const entries = includeEntries
    ? Object.values(report.entries)
        .filter((e) => e.error || !e.present || !e.allowed)
        .slice(0, 500)
    : undefined;
  return NextResponse.json({
    report: {
      mode: report.mode,
      startedAt: report.startedAt,
      updatedAt: report.updatedAt,
      totals: report.totals,
      problems: entries,
    },
  });
}

/** POST → enqueue a migration step as a durable job. Originals are never deleted. */
export async function POST(request: NextRequest) {
  const auth = await requireFilesAdmin();
  if ('response' in auth) return auth.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = runSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  const job = await enqueueJob({
    type: STORAGE_MIGRATE_JOB,
    payload: parsed.data,
    priority: JOB_PRIORITY.maintenance,
    dedupeKey: `${STORAGE_MIGRATE_JOB}:${parsed.data.mode}`,
    createdBy: auth.user.id,
    maxAttempts: 1,
  });
  await recordAuditEvent({
    actorUserId: auth.user.id,
    action: 'storage.migration_requested',
    targetType: 'storage',
    targetId: job.id,
    metadata: { mode: parsed.data.mode, deduplicated: job.deduplicated },
  });
  return NextResponse.json({ jobId: job.id, deduplicated: job.deduplicated });
}
