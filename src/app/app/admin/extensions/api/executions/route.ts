import { NextRequest, NextResponse } from 'next/server';
import { requireExtensionsViewer } from '@/app/app/assistant/api/extensions/_shared';
import { listExecutions } from '@/modules/extensions/extensions-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireExtensionsViewer();
  if ('response' in auth) return auth.response;
  const p = request.nextUrl.searchParams;
  return NextResponse.json({
    executions: await listExecutions({
      extensionId: p.get('extensionId') ?? undefined,
      status: p.get('status') ?? undefined,
      userId: p.get('userId') ?? undefined,
      limit: p.get('limit') ? Number(p.get('limit')) : undefined,
    }),
  });
}
