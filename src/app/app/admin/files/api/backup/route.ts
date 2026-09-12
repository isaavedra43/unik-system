import { NextResponse } from 'next/server';
import { requireFilesAdmin } from '../_auth';
import { enqueueJob, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { STORAGE_BACKUP_JOB } from '@/modules/storage/storage-jobs';
import { getBackupCheckpoint } from '@/modules/storage/storage-backup-service';
import { recordAuditEvent } from '@/modules/auth/audit-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireFilesAdmin();
  if ('response' in auth) return auth.response;
  return NextResponse.json({ checkpoint: await getBackupCheckpoint() });
}

/** POST → run an incremental backup now (durable job). */
export async function POST() {
  const auth = await requireFilesAdmin();
  if ('response' in auth) return auth.response;
  const job = await enqueueJob({
    type: STORAGE_BACKUP_JOB,
    payload: { manual: true },
    priority: JOB_PRIORITY.maintenance,
    dedupeKey: `${STORAGE_BACKUP_JOB}:manual`,
    createdBy: auth.user.id,
    maxAttempts: 1,
  });
  await recordAuditEvent({
    actorUserId: auth.user.id,
    action: 'storage.backup_requested',
    targetType: 'storage',
    targetId: job.id,
  });
  return NextResponse.json({ jobId: job.id, deduplicated: job.deduplicated });
}
