import { NextRequest, NextResponse } from 'next/server';
import {
  deleteTemplate,
  getTemplate,
  templateSchema,
  updateTemplate,
} from '@/modules/studio/studio-service';
import { readJson, requireStudio, studioErrorResponse } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const auth = await requireStudio();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json({ template: await getTemplate(auth.user, id) });
  } catch (err) {
    return studioErrorResponse(err);
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await requireStudio();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = templateSchema.partial().parse(await readJson(request));
    return NextResponse.json({ template: await updateTemplate(auth.user, id, body) });
  } catch (err) {
    return studioErrorResponse(err);
  }
}

/** DELETE — archives the template (soft delete). */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const auth = await requireStudio();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    await deleteTemplate(auth.user, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return studioErrorResponse(err);
  }
}
