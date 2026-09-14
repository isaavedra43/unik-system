import { NextRequest, NextResponse } from 'next/server';
import { requireKnowledgeAdmin, knowledgeError } from '../../_auth';
import {
  deleteSource,
  getSourceDetail,
  updateSource,
  updateSourceSchema,
} from '@/modules/copilot/knowledge-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?versionId= — the source, its versions and the fragments the assistant reads for that version. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireKnowledgeAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json(await getSourceDetail(id, request.nextUrl.searchParams.get('versionId')));
  } catch (err) {
    return knowledgeError(err);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireKnowledgeAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = updateSourceSchema.parse(await request.json());
    const source = await updateSource(auth.user, id, body);
    return NextResponse.json({ id: source.id, status: source.status });
  } catch (err) {
    return knowledgeError(err);
  }
}

/** DELETE — removes the source for good: versions, index and stored files. */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireKnowledgeAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json(await deleteSource(auth.user, id));
  } catch (err) {
    return knowledgeError(err);
  }
}
