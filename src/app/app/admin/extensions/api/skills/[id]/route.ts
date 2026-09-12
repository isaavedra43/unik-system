import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { extensionErrorResponse, readJson } from '@/app/app/assistant/api/extensions/_shared';
import { setSkillStatus } from '@/modules/extensions/skills-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ status: z.enum(['published', 'suspended', 'draft']) });

/** PATCH — publish/suspend a team skill (skills.manage). */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!hasPermission(session.user, 'skills.manage'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const { id } = await params;
  try {
    const body = schema.parse(await readJson(request));
    return NextResponse.json({ skill: await setSkillStatus(session.user, id, body.status) });
  } catch (err) {
    return extensionErrorResponse(err);
  }
}
