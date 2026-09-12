import { prisma } from '@/lib/prisma';
import { registerFileAccessResolver } from '@/modules/storage/storage-access';
import { actorHas, supervisorCanAccess } from './voice-service';

/**
 * File access for recordings and transcripts. Both purposes are restricted
 * (always served through the authenticated streaming endpoint with Range):
 * - participants of the call (`calls.use`),
 * - supervisors of the permitted teams (`calls.supervise`),
 * - super administrators.
 *
 * Knowing the object id never grants access. This module must be imported
 * where `resolveFileAccess` runs (see docs/voice.md → integration).
 */

async function callForObject(objectId: string, kind: 'recording' | 'transcript') {
  return prisma.voiceCall.findFirst({
    where:
      kind === 'recording' ? { recordingObjectId: objectId } : { transcriptObjectId: objectId },
    include: { participants: { where: { role: { not: 'supervisor' } } } },
  });
}

async function actorMayReadCallFile(
  actor: Parameters<typeof supervisorCanAccess>[0],
  call: NonNullable<Awaited<ReturnType<typeof callForObject>>>
): Promise<boolean> {
  if (actor.isSuperAdmin) return true;
  if (actorHas(actor, 'calls.use') && call.participants.some((p) => p.userId === actor.id)) {
    return true;
  }
  return supervisorCanAccess(actor, call);
}

registerFileAccessResolver('recording', async (actor, object) => {
  const call = await callForObject(object.id, 'recording');
  if (!call) return false;
  return actorMayReadCallFile(actor, call);
});

registerFileAccessResolver('transcript', async (actor, object) => {
  const call = await callForObject(object.id, 'transcript');
  if (!call) return false;
  return actorMayReadCallFile(actor, call);
});
