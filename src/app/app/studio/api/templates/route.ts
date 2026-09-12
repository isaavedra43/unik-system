import { NextRequest, NextResponse } from 'next/server';
import { createTemplate, listTemplates, templateSchema } from '@/modules/studio/studio-service';
import { readJson, requireStudio, studioErrorResponse } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireStudio();
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json({ templates: await listTemplates(auth.user) });
  } catch (err) {
    return studioErrorResponse(err);
  }
}

/** POST — personal template (team scope requires studio.approve, enforced by the service). */
export async function POST(request: NextRequest) {
  const auth = await requireStudio();
  if ('response' in auth) return auth.response;
  try {
    const body = templateSchema.parse(await readJson(request));
    return NextResponse.json({ template: await createTemplate(auth.user, body) }, { status: 201 });
  } catch (err) {
    return studioErrorResponse(err);
  }
}
