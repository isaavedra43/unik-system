import { NextResponse } from 'next/server';
import { isInternalApiKeyValid } from '@/lib/internal-api-key';
import { getJob } from '@/modules/jobs/job-queue';

export const runtime = 'nodejs';

/** GET /api/internal/storage/jobs/[id]  (X-UNIK-API-Key) — job status for scripts. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isInternalApiKeyValid(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    attempts: job.attempts,
    last_error: job.lastError,
    result: job.result,
    created_at: job.createdAt.toISOString(),
    completed_at: job.completedAt?.toISOString() ?? null,
  });
}
