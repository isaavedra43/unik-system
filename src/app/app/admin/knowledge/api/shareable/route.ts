import { NextRequest, NextResponse } from 'next/server';
import { requireKnowledgeAdmin, knowledgeError } from '../_auth';
import { findShareableDocuments } from '@/modules/copilot/knowledge-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?q= — which authorized file the assistant would send for a request (same logic as findShareableDocument). */
export async function GET(request: NextRequest) {
  const auth = await requireKnowledgeAdmin();
  if ('response' in auth) return auth.response;
  const q = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (q.length < 2) return NextResponse.json({ error: 'Escribe qué archivo pedirías' }, { status: 400 });
  try {
    return NextResponse.json(await findShareableDocuments(q, 5));
  } catch (err) {
    return knowledgeError(err);
  }
}
