import { NextRequest, NextResponse } from 'next/server';
import { requireFilesAdmin } from '../_auth';
import { listStorageJobs } from '@/modules/storage/storage-admin-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireFilesAdmin();
  if ('response' in auth) return auth.response;
  const type = request.nextUrl.searchParams.get('type') ?? undefined;
  return NextResponse.json({ jobs: await listStorageJobs(type) });
}
