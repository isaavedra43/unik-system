import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { resolveFileAccess } from '@/modules/storage/storage-access';
import { toObjectStatusDTO } from '@/modules/storage/storage-service';
import { prisma } from '@/lib/prisma';
import { storageErrorResponse } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/files/api/objects/[id]
 * Status/metadata of an object. The uploader may poll their own pending
 * uploads; ready objects require access through a referencing resource.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const { id } = await params;
  try {
    const decision = await resolveFileAccess(session.user, id);
    if (!decision) return NextResponse.json({ error: 'Archivo no encontrado' }, { status: 404 });
    let allowed = decision.allowed;
    if (!allowed && decision.object.createdBy === session.user.id) {
      // The uploader can always follow the state of their own upload.
      const own = await prisma.uploadSession.findUnique({
        where: { objectId: id },
        select: { userId: true },
      });
      allowed = own?.userId === session.user.id;
    }
    if (!allowed) return NextResponse.json({ error: 'Archivo no encontrado' }, { status: 404 });
    const dto = toObjectStatusDTO(decision.object);
    // Internal validation policy is not part of the public contract.
    if (dto.metadata) {
      const { validation, target, ...rest } = dto.metadata;
      void validation;
      void target;
      dto.metadata = rest;
    }
    return NextResponse.json(dto);
  } catch (err) {
    return storageErrorResponse(err);
  }
}
