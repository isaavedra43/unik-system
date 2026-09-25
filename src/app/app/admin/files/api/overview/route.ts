import { NextResponse } from 'next/server';
import { requireFilesAdmin } from '../_auth';
import { getStorageOverview } from '@/modules/storage/storage-admin-service';
import { apiErrorResponse } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireFilesAdmin();
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json(await getStorageOverview());
  } catch (err) {
    return apiErrorResponse(err, { context: 'overview' });
  }
}
