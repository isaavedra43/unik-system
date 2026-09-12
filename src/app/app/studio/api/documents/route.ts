import { NextRequest, NextResponse } from 'next/server';
import {
  createDocument,
  createDocumentSchema,
  listDocuments,
} from '@/modules/studio/studio-service';
import { readJson, requireStudio, studioErrorResponse } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /app/studio/api/documents?scope=mine|team&includeArchived=1 */
export async function GET(request: NextRequest) {
  const auth = await requireStudio();
  if ('response' in auth) return auth.response;
  const scope = request.nextUrl.searchParams.get('scope') === 'team' ? 'team' : 'mine';
  const includeArchived = request.nextUrl.searchParams.get('includeArchived') === '1';
  try {
    return NextResponse.json({
      documents: await listDocuments(auth.user, { scope, includeArchived }),
    });
  } catch (err) {
    return studioErrorResponse(err);
  }
}

/** POST /app/studio/api/documents — create (blank, from template or from an AI artifact). */
export async function POST(request: NextRequest) {
  const auth = await requireStudio();
  if ('response' in auth) return auth.response;
  try {
    const body = createDocumentSchema.parse(await readJson(request));
    const document = await createDocument(auth.user, body);
    return NextResponse.json({ document }, { status: 201 });
  } catch (err) {
    return studioErrorResponse(err);
  }
}
