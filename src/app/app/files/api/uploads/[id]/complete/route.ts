import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession } from '@/modules/auth/authorization';
import { completeUpload } from '@/modules/storage/storage-service';
import { storageErrorResponse } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const completeSchema = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1).max(200) }))
    .max(10_000)
    .default([]),
});

/**
 * POST /app/files/api/uploads/[id]/complete
 * Finalizes the upload, verifies size, and hands the object to validation.
 * Idempotent: repeating the call returns the current object status.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const { id } = await params;
  let body: unknown = {};
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = completeSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  try {
    const result = await completeUpload(session.user.id, id, parsed.data.parts);
    return NextResponse.json(result);
  } catch (err) {
    return storageErrorResponse(err);
  }
}
