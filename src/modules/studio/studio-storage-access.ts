import { prisma } from '@/lib/prisma';
import { hasPermission } from '@/modules/auth/authorization';
import {
  registerFileAccessResolver,
  registerUploadTargetResolver,
} from '@/modules/storage/storage-access';
import { StorageError } from '@/modules/storage/storage-service';
import { canEditDocument, canViewDocument } from './studio-service';

/**
 * Storage integration of the studio.
 *
 * Upload target `studio_document` (id = document id): images placed inside a
 * document or the edited binary of an image document. Policy purpose is
 * `document`; approved/shared documents get protected retention. No module
 * record is created at upload time — the reference is the version content the
 * client saves right after (`assertImageObjectsAllowed` in the service checks
 * that only the uploader can attach the object).
 *
 * File access for purpose `document`: allowed when the actor may view a
 * document whose version (binary or image block) or export references the object.
 */

export const STUDIO_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const STUDIO_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

registerUploadTargetResolver('studio_document', async (actor, documentId) => {
  if (!hasPermission(actor, 'studio.use')) {
    throw new StorageError('Sin permiso para usar el estudio', 'forbidden', 403);
  }
  const doc = await prisma.studioDocument.findUnique({
    where: { id: documentId },
    select: { id: true, ownerUserId: true, visibility: true, status: true },
  });
  if (!doc || !canViewDocument(actor, doc)) {
    throw new StorageError('Documento no encontrado', 'not_found', 404);
  }
  if (!canEditDocument(actor, doc)) {
    throw new StorageError('Sin permiso para editar este documento', 'forbidden', 403);
  }
  return {
    policy: {
      purpose: 'document',
      maxBytes: STUDIO_IMAGE_MAX_BYTES,
      allowedMimeTypes: STUDIO_IMAGE_MIME_TYPES,
      retentionPolicy:
        doc.status === 'approved' || doc.status === 'shared' ? 'protected' : 'default',
    },
  };
});

registerFileAccessResolver('document', async (actor, object) => {
  if (!hasPermission(actor, 'studio.use')) return false;
  const select = { ownerUserId: true, visibility: true } as const;

  const [versionRefs, exportRefs, imageRefs] = await Promise.all([
    prisma.studioDocumentVersion.findMany({
      where: { storageObjectId: object.id },
      select: { document: { select } },
      take: 20,
    }),
    prisma.studioExport.findMany({
      where: { storageObjectId: object.id },
      select: { document: { select } },
      take: 20,
    }),
    prisma.studioDocumentVersion.findMany({
      where: { content: { path: ['blocks'], array_contains: [{ storageObjectId: object.id }] } },
      select: { document: { select } },
      take: 20,
    }),
  ]);
  for (const ref of [...versionRefs, ...exportRefs, ...imageRefs]) {
    if (canViewDocument(actor, ref.document)) return true;
  }
  // The uploader may always see a file they just uploaded and have not placed yet.
  return object.createdBy === actor.id && object.purpose === 'document';
});
