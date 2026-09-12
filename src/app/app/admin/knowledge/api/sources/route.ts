import { NextRequest, NextResponse } from 'next/server';
import { requireKnowledgeAdmin, knowledgeError } from '../_auth';
import { createSource, createSourceSchema, listSources } from '@/modules/copilot/knowledge-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireKnowledgeAdmin();
  if ('response' in auth) return auth.response;
  const p = request.nextUrl.searchParams;
  return NextResponse.json({
    sources: await listSources({
      status: p.get('status') ?? undefined,
      visibility: p.get('visibility') ?? undefined,
    }),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireKnowledgeAdmin();
  if ('response' in auth) return auth.response;
  try {
    const body = createSourceSchema.parse(await request.json());
    const source = await createSource(auth.user, body);
    return NextResponse.json({ id: source.id }, { status: 201 });
  } catch (err) {
    return knowledgeError(err);
  }
}
