import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession } from '@/modules/auth/authorization';
import { signUploadParts } from '@/modules/storage/storage-service';
import { storageErrorResponse } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const partsSchema = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
});

/**
 * POST /app/files/api/uploads/[id]/parts
 * Authorizes concrete parts of an upload owned by the caller.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = partsSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  try {
    const parts = await signUploadParts(session.user.id, id, parsed.data.partNumbers);
    return NextResponse.json({ parts });
  } catch (err) {
    return storageErrorResponse(err);
  }
}
