import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAssistantUser, extensionErrorResponse, readJson } from '../../extensions/_shared';
import {
  deleteSkill,
  setSkillStatus,
  skillDefinitionSchema,
  updateSkill,
} from '@/modules/extensions/skills-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  purpose: z.string().min(2).max(1000).optional(),
  definition: skillDefinitionSchema.optional(),
  status: z.enum(['published', 'suspended', 'draft']).optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = patchSchema.parse(await readJson(request));
    let skill = await updateSkill(auth.user, id, {
      name: body.name,
      purpose: body.purpose,
      definition: body.definition,
    });
    if (body.status) skill = await setSkillStatus(auth.user, id, body.status);
    return NextResponse.json({ skill });
  } catch (err) {
    return extensionErrorResponse(err);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    await deleteSkill(auth.user, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return extensionErrorResponse(err);
  }
}
