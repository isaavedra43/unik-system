import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireKnowledgeAdmin, knowledgeError } from '../../../_auth';
import { approveVersion } from '@/modules/copilot/knowledge-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ versionId: z.string().min(1) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireKnowledgeAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = schema.parse(await request.json());
    const source = await approveVersion(auth.user, id, body.versionId);
    return NextResponse.json({
      id: source.id,
      status: source.status,
      currentVersionId: source.currentVersionId,
    });
  } catch (err) {
    return knowledgeError(err);
  }
}
