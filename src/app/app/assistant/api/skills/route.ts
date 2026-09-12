import { NextRequest, NextResponse } from 'next/server';
import { requireAssistantUser, extensionErrorResponse, readJson } from '../extensions/_shared';
import {
  createSkill,
  createSkillSchema,
  listSkillsForUser,
} from '@/modules/extensions/skills-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — skills the caller may run. POST — create a personal skill (team scope needs skills.manage). */
export async function GET() {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  return NextResponse.json({ skills: await listSkillsForUser(auth.user) });
}

export async function POST(request: NextRequest) {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  try {
    const body = createSkillSchema.parse(await readJson(request));
    return NextResponse.json({ skill: await createSkill(auth.user, body) }, { status: 201 });
  } catch (err) {
    return extensionErrorResponse(err);
  }
}
