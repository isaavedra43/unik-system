import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireKnowledgeAdmin, knowledgeError } from '../../_auth';
import { createSourceSchema, updateSource } from '@/modules/copilot/knowledge-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = createSourceSchema
  .partial()
  .extend({ status: z.enum(['draft', 'approved', 'archived']).optional() });

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireKnowledgeAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = patchSchema.parse(await request.json());
    const source = await updateSource(auth.user, id, body);
    return NextResponse.json({ id: source.id, status: source.status });
  } catch (err) {
    return knowledgeError(err);
  }
}
