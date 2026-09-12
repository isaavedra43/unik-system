import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'stream';
import { receiveDiskPart } from '@/modules/storage/storage-service';
import { verifyUploadPartToken } from '@/modules/storage/upload-tokens';
import { storageErrorResponse } from '../../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * PUT /app/files/api/uploads/[id]/parts/[partNumber]?token=…
 *
 * Direct upload endpoint of the DISK driver (local development / emulator).
 * It plays the role of an R2 presigned URL: the HMAC token authorizes ONE
 * part of ONE upload for a few minutes and nothing else. With the R2 driver
 * the browser never calls this route (it PUTs straight to R2).
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; partNumber: string }> }
) {
  const { id, partNumber } = await params;
  const token = request.nextUrl.searchParams.get('token');
  if (!token) return NextResponse.json({ error: 'Falta autorización' }, { status: 401 });
  const claims = verifyUploadPartToken(token);
  const n = Number(partNumber);
  if (!claims || claims.uploadId !== id || claims.partNumber !== n) {
    return NextResponse.json({ error: 'Autorización inválida o expirada' }, { status: 403 });
  }
  if (!request.body) return NextResponse.json({ error: 'Cuerpo vacío' }, { status: 400 });
  try {
    const body = Readable.fromWeb(
      request.body as unknown as import('stream/web').ReadableStream<Uint8Array>
    );
    const { etag } = await receiveDiskPart(claims, body);
    return new NextResponse(null, { status: 200, headers: { ETag: etag } });
  } catch (err) {
    return storageErrorResponse(err);
  }
}
