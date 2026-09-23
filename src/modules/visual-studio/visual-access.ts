import { prisma } from '@/lib/prisma';
import { hasPermission } from '@/modules/auth/authorization';
import {
  registerFileAccessResolver,
  registerUploadTargetResolver,
} from '@/modules/storage/storage-access';
import { StorageError } from '@/modules/storage/storage-service';

/**
 * Seguridad de archivos de Visual Studio.
 *
 * - Subidas: solo contra `visual_project:<projectId>` con permiso
 *   visual_studio.edit; imágenes hasta 20 MB, propósito `visual`.
 * - Descargas: un objeto `visual` es legible si quien pide tiene
 *   visual_studio.view y el objeto está referenciado por un proyecto visible.
 *   UNIK es mono-empresa: el aislamiento es por permiso y propiedad, no por
 *   tenant.
 */

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

export function registerVisualStudioResolvers(): void {
  registerUploadTargetResolver('visual_project', async (actor, projectId) => {
    if (!hasPermission(actor, 'visual_studio.edit')) {
      throw new StorageError('Sin permiso para subir a Visual Studio', 'forbidden', 403);
    }
    const project = await prisma.visualProject.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) throw new StorageError('Proyecto no encontrado', 'not_found', 404);
    return {
      policy: {
        purpose: 'visual',
        maxBytes: MAX_IMAGE_BYTES,
        allowedMimeTypes: IMAGE_MIME,
      },
      createReference: async (object) => {
        const asset = await prisma.visualAsset.create({
          data: {
            projectId,
            kind: 'source',
            objectId: object.id,
            label: object.originalName,
            createdById: actor.id,
          },
        });
        return { referenceId: asset.id };
      },
    };
  });

  registerUploadTargetResolver('product_media', async (actor, productId) => {
    if (!hasPermission(actor, 'visual_studio.media')) {
      throw new StorageError('Sin permiso para gestionar medios de producto', 'forbidden', 403);
    }
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) throw new StorageError('Producto no encontrado', 'not_found', 404);
    return {
      policy: {
        purpose: 'visual',
        maxBytes: MAX_IMAGE_BYTES,
        allowedMimeTypes: IMAGE_MIME,
      },
      createReference: async (object) => {
        const media = await prisma.productMedia.create({
          data: { productId, objectId: object.id, kind: 'reference', createdById: actor.id },
        });
        return { referenceId: media.id };
      },
    };
  });

  registerFileAccessResolver('visual', async (actor, object) => {
    if (!hasPermission(actor, 'visual_studio.view')) return false;
    const referenced =
      (await prisma.visualAsset.count({ where: { objectId: object.id } })) > 0 ||
      (await prisma.visualSurface.count({ where: { maskObjectId: object.id } })) > 0 ||
      (await prisma.visualProposal.count({ where: { resultObjectId: object.id } })) > 0 ||
      (await prisma.productMedia.count({ where: { objectId: object.id } })) > 0;
    return referenced;
  });
}

const g = globalThis as { __unikVisualResolvers?: boolean };
if (!g.__unikVisualResolvers) {
  g.__unikVisualResolvers = true;
  registerVisualStudioResolvers();
}
