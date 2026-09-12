import { NextRequest, NextResponse } from 'next/server';
import { requireKnowledgeAdmin, knowledgeError } from '../../../_auth';
import { createVersion, createVersionSchema } from '@/modules/copilot/knowledge-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST — new version from an uploaded object (target knowledge_source), raw text or URL; processing runs as a job. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireKnowledgeAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = createVersionSchema.parse(await request.json());
    const version = await createVersion(auth.user, id, body);
    return NextResponse.json(
      { id: version.id, version: version.version, status: version.status },
      { status: 201 }
    );
  } catch (err) {
    return knowledgeError(err);
  }
}
