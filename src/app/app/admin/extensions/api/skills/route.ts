import { NextRequest, NextResponse } from 'next/server';
import { requireExtensionsViewer } from '@/app/app/assistant/api/extensions/_shared';
import { listAllSkills } from '@/modules/extensions/skills-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireExtensionsViewer();
  if ('response' in auth) return auth.response;
  const p = request.nextUrl.searchParams;
  return NextResponse.json({
    skills: await listAllSkills({
      scope: p.get('scope') ?? undefined,
      status: p.get('status') ?? undefined,
    }),
  });
}
