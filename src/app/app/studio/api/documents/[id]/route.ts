import { NextRequest, NextResponse } from 'next/server';
import {
  archiveDocument,
  getDocument,
  saveDocument,
  saveDocumentSchema,
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
    return NextResponse.json({ document: await getDocument(auth.user, id) });
  } catch (err) {
    return studioErrorResponse(err);
  }
}

/** PATCH — title and/or content. Content changes ALWAYS create a new version. */
export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await requireStudio();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = saveDocumentSchema.parse(await readJson(request));
    const result = await saveDocument(auth.user, id, body);
    return NextResponse.json(result);
  } catch (err) {
    return studioErrorResponse(err);
  }
}

/** DELETE — archives (never destroys versions or files). */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const auth = await requireStudio();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json({ document: await archiveDocument(auth.user, id) });
  } catch (err) {
    return studioErrorResponse(err);
  }
}
