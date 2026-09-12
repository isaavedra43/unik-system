import { NextRequest, NextResponse } from 'next/server';
import { aiEditRequestSchema, aiEditSelection } from '@/modules/studio/studio-ai-edit';
import { readJson, requireStudio, studioErrorResponse } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST {blockIds, instruction} — AI rewrite of the selected blocks only; creates a version. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireStudio();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = aiEditRequestSchema.parse(await readJson(request));
    const result = await aiEditSelection(auth.user, id, body);
    return NextResponse.json(result);
  } catch (err) {
    return studioErrorResponse(err);
  }
}
