import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { registerJobHandler } from '@/modules/jobs/job-queue';
import type { CurrentUser } from '@/modules/auth/authorization';
import { isKnownPermission } from '@/modules/auth/permissions';
import { SUPER_ADMIN_ROLE_KEY } from '@/modules/auth/constants';
import type { PermissionKey } from '@/modules/auth/permissions';
import {
  getStorageObject,
  readObjectToBuffer,
  saveGeneratedFile,
} from '@/modules/storage/storage-service';
import { notifyUser } from '@/modules/notifications/notification-service';
import {
  downloadResult,
  pollGeneration,
  submitGeneration,
  uploadMedia,
  VisualProviderError,
} from './higgsfield-adapter';
import { VISUAL_GENERATE_JOB } from './visual-service';

/**
 * Job `visual.generate`: ejecuta la generación de una propuesta contra
 * Higgsfield fuera del request HTTP del usuario.
 *
 * Pipeline: foto + máscara + referencias del producto → media_upload →
 * generate_image → job_status hasta estado terminal → descarga → storage.
 * Cada paso deja rastro en generationParams/providerJobId; los fallos dejan
 * la propuesta en `failed` con el mensaje — jamás `completed` ficticio.
 */

const MAX_READ_BYTES = 20 * 1024 * 1024;
const POLL_INTERVAL_MS = 4_000;
const POLL_DEADLINE_MS = 5 * 60 * 1000;

/** Reconstruye el actor del job desde la BD (misma forma que la sesión). */
async function actorForJob(userId: string): Promise<CurrentUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: { include: { role: { include: { permissions: true } } } } },
  });
  if (!user) throw new Error(`Usuario ${userId} no encontrado para el trabajo`);
  const activeRoles = user.roles.map((ur) => ur.role).filter((r) => r.isActive);
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    mustChangePassword: user.mustChangePassword,
    roleKeys: activeRoles.map((r) => r.key),
    permissionKeys: [
      ...new Set(activeRoles.flatMap((r) => r.permissions.map((p) => p.permissionKey))),
    ].filter((k): k is PermissionKey => isKnownPermission(k)),
    isSuperAdmin: activeRoles.some((r) => r.key === SUPER_ADMIN_ROLE_KEY),
  };
}

async function objectBuffer(objectId: string): Promise<{ buffer: Buffer; name: string; mime: string }> {
  const object = await getStorageObject(objectId);
  if (!object || object.status !== 'ready') {
    throw new VisualProviderError('Archivo de entrada no disponible en storage', 'upload');
  }
  return {
    buffer: await readObjectToBuffer(object, MAX_READ_BYTES),
    name: object.originalName,
    mime: object.detectedMimeType ?? object.declaredMimeType,
  };
}

function guessMime(bytes: Buffer): string {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes.length > 12 && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'image/png';
}

function extFor(mime: string): string {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
}

async function failProposal(proposalId: string, message: string): Promise<void> {
  await prisma.visualProposal.update({
    where: { id: proposalId },
    data: { status: 'failed', error: message.slice(0, 1000) },
  });
}

registerJobHandler<{ proposalId: string; actorId: string }>(
  VISUAL_GENERATE_JOB,
  async (ctx) => {
    const { proposalId, actorId } = ctx.payload;
    const proposal = await prisma.visualProposal.findUnique({
      where: { id: proposalId },
      include: {
        project: true,
        surface: { include: { asset: true } },
        product: { include: { media: { take: 3, orderBy: { createdAt: 'asc' } } } },
      },
    });
    if (!proposal) throw new Error('Propuesta no encontrada');
    if (proposal.status === 'cancelled') return { skipped: 'cancelled' };
    if (proposal.status === 'completed' && proposal.resultObjectId) return { skipped: 'completed' };

    const actor = await actorForJob(actorId);
    await prisma.visualProposal.update({
      where: { id: proposalId },
      data: { status: 'processing', error: null },
    });

    try {
      // 1. Media: foto original + máscara (faithful) + referencias del material.
      const photo = await objectBuffer(proposal.surface!.asset.objectId);
      const photoMedia = await uploadMedia(actor, {
        bytes: photo.buffer,
        fileName: photo.name,
        mimeType: photo.mime,
      });
      await ctx.setProgress(20);

      let maskMediaId: string | undefined;
      if (proposal.mode === 'faithful' && proposal.surface) {
        const mask = await objectBuffer(proposal.surface.maskObjectId);
        const maskMedia = await uploadMedia(actor, {
          bytes: mask.buffer,
          fileName: 'mask.png',
          mimeType: 'image/png',
        });
        maskMediaId = maskMedia.mediaId;
      }
      await ctx.setProgress(35);

      const materialMediaIds: string[] = [];
      for (const media of proposal.product?.media ?? []) {
        const ref = await objectBuffer(media.objectId);
        const uploaded = await uploadMedia(actor, {
          bytes: ref.buffer,
          fileName: ref.name,
          mimeType: ref.mime,
        });
        materialMediaIds.push(uploaded.mediaId);
      }
      await ctx.setProgress(50);

      // 2. Someter generación.
      const submitted = await submitGeneration(actor, {
        mode: proposal.mode as 'faithful' | 'creative',
        prompt: proposal.prompt,
        photoMediaId: photoMedia.mediaId,
        maskMediaId,
        materialMediaIds,
        model: proposal.model ?? undefined,
      });
      await prisma.visualProposal.update({
        where: { id: proposalId },
        data: {
          providerJobId: submitted.providerJobId,
          generationParams: {
            model: proposal.model,
            mode: proposal.mode,
            mediaCount: 1 + (maskMediaId ? 1 : 0) + materialMediaIds.length,
          } as Prisma.InputJsonValue,
        },
      });
      await ctx.setProgress(60);

      // 3. Esperar resultado terminal.
      const deadline = Date.now() + POLL_DEADLINE_MS;
      let state = await pollGeneration(actor, submitted.providerJobId);
      while (state.status === 'pending' || state.status === 'processing') {
        if (ctx.signal.aborted) throw new Error('cancelled');
        if (Date.now() > deadline) {
          throw new VisualProviderError('El proveedor no respondió a tiempo', 'poll');
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        state = await pollGeneration(actor, submitted.providerJobId);
      }
      if (state.status === 'failed') {
        throw new VisualProviderError(state.error, 'poll');
      }
      if (state.status !== 'completed') {
        throw new VisualProviderError('El proveedor devolvió un estado inesperado', 'poll');
      }
      const url = state.resultUrls[0];
      if (!url) throw new VisualProviderError('Resultado sin URL de imagen', 'download');
      await ctx.setProgress(80);

      // 4. Descargar y persistir en el storage de UNIK.
      const bytes = await downloadResult(url);
      const mime = guessMime(bytes);
      const stored = await saveGeneratedFile({
        createdBy: actorId,
        purpose: 'visual',
        fileName: `propuesta-v${proposal.version}.${extFor(mime)}`,
        mimeType: mime,
        source: { buffer: bytes },
        restricted: true,
      });
      await prisma.visualProposal.update({
        where: { id: proposalId },
        data: { status: 'completed', resultObjectId: stored.id, error: null },
      });
      await ctx.setProgress(100);

      await notifyUser({
        userId: proposal.createdById,
        category: 'ai_task_done',
        type: 'visual_proposal_done',
        title: 'Propuesta visual lista',
        body: `${proposal.project.name} — versión ${proposal.version}`,
        url: `/app/visual-studio/${proposal.projectId}`,
        entityType: 'visual_proposal',
        entityId: proposal.id,
        dedupeKey: `visual-done:${proposal.id}`,
      });
      return { proposalId, providerJobId: submitted.providerJobId };
    } catch (err) {
      const message =
        err instanceof VisualProviderError ? err.message : err instanceof Error ? err.message : String(err);
      await failProposal(proposalId, message);
      await notifyUser({
        userId: proposal.createdById,
        category: 'ai_task_done',
        type: 'visual_proposal_failed',
        title: 'La propuesta visual falló',
        body: message.slice(0, 300),
        url: `/app/visual-studio/${proposal.projectId}`,
        entityType: 'visual_proposal',
        entityId: proposal.id,
        dedupeKey: `visual-failed:${proposal.id}:${proposal.version}:${Date.now() >> 12}`,
      }).catch(() => undefined);
      // Re-lanzar para que el job quede en failed y el reintento sea visible.
      throw err;
    }
  },
  { timeoutMs: 10 * 60 * 1000 }
);
