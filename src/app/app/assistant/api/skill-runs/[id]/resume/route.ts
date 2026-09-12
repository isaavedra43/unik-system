import { NextRequest, NextResponse } from 'next/server';
import { requireAssistantUser, extensionErrorResponse } from '../../../extensions/_shared';
import { resumeSkillRun } from '@/modules/extensions/skill-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json(await resumeSkillRun(auth.user, id));
  } catch (err) {
    return extensionErrorResponse(err);
  }
}
