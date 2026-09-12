import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession } from '@/modules/auth/authorization';
import { resolveUploadTarget } from '@/modules/storage/storage-access';
import { initiateUpload } from '@/modules/storage/storage-service';
import { storageErrorResponse } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const initiateSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.number().int().positive(),
  target: z.object({
    type: z.string().min(1).max(50),
    id: z.string().min(1).max(100),
  }),
});

/**
 * POST /app/files/api/uploads
 *
 * Starts an upload to an authorized destination. The server verifies the
 * session, the permission and the access to the target, reserves quota,
 * creates the UploadSession and returns the per-part authorizations
 * (single-part uploads get their PUT authorization right away).
 *
 * Response: { uploadId, objectId, referenceId?, multipart, partSize, partCount, expiresAt, parts? }
 */
export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = initiateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Datos inválidos', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const { fileName, mimeType, sizeBytes, target } = parsed.data;

  try {
    const resolution = await resolveUploadTarget(session.user, target, {
      fileName,
      mimeType,
      sizeBytes,
    });
    const result = await initiateUpload({
      actorId: session.user.id,
      fileName,
      declaredMimeType: mimeType,
      declaredSize: sizeBytes,
      target,
      policy: resolution.policy,
    });
    let referenceId: string | null = null;
    if (resolution.createReference) {
      referenceId = (await resolution.createReference(result.object)).referenceId;
    }
    return NextResponse.json({
      uploadId: result.uploadId,
      objectId: result.objectId,
      referenceId,
      multipart: result.multipart,
      partSize: result.partSize,
      partCount: result.partCount,
      expiresAt: result.expiresAt,
      parts: result.parts ?? [],
    });
  } catch (err) {
    return storageErrorResponse(err);
  }
}
