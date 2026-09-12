import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  requireAssistantUser,
  extensionErrorResponse,
  readJson,
} from '../../../extensions/_shared';
import { runSkillByKey } from '@/modules/extensions/skill-runner';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const schema = z.object({
  inputs: z.record(z.unknown()).default({}),
  conversationId: z.string().optional(),
});

/** POST — runs a skill with the given inputs; pauses on approval points. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = schema.parse(await readJson(request));
    const skill = await prisma.skill.findUnique({ where: { id }, select: { key: true } });
    if (!skill) return NextResponse.json({ error: 'Skill no encontrada' }, { status: 404 });
    return NextResponse.json(
      await runSkillByKey(auth.user, skill.key, body.inputs, {
        conversationId: body.conversationId,
      })
    );
  } catch (err) {
    return extensionErrorResponse(err);
  }
}
