import { NextRequest, NextResponse } from 'next/server';
import { requireKnowledgeAdmin, knowledgeError } from '../../../_auth';
import { getVersionPreview } from '@/modules/copilot/knowledge-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?versionId= — renderable preview of a version (PDF url, Word HTML, sheet rows, page text). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireKnowledgeAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json(await getVersionPreview(id, request.nextUrl.searchParams.get('versionId')));
  } catch (err) {
    return knowledgeError(err);
  }
}
