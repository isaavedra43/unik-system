import { NextResponse } from 'next/server';
import { requireFilesAdmin } from '../_auth';
import { enqueueJob, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { STORAGE_RECONCILE_JOB } from '@/modules/storage/storage-jobs';
import { getLastReconcile } from '@/modules/storage/storage-migration-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireFilesAdmin();
  if ('response' in auth) return auth.response;
  return NextResponse.json({ last: await getLastReconcile() });
}

/** POST → compare database and storage in both directions (report only, nothing deleted). */
export async function POST() {
  const auth = await requireFilesAdmin();
  if ('response' in auth) return auth.response;
  const job = await enqueueJob({
    type: STORAGE_RECONCILE_JOB,
    payload: {},
    priority: JOB_PRIORITY.maintenance,
    dedupeKey: `${STORAGE_RECONCILE_JOB}:manual`,
    createdBy: auth.user.id,
    maxAttempts: 1,
  });
  return NextResponse.json({ jobId: job.id, deduplicated: job.deduplicated });
}
