import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { registerJobHandler, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import { publishRealtime, REALTIME_CHANNELS } from '@/modules/realtime/realtime-service';
import { saveGeneratedFile } from '@/modules/storage/storage-service';
import { getChannelAdapter, hasMediaFetcher } from './adapters';
import { markOverdueCommitments } from './commitments-service';
import { COMMS_PROCESS_INBOUND_JOB } from './comms-service';
import './comms-storage';

/**
 * Background jobs owned by the communications module.
 *
 * - comms.process_inbound      → downloads provider media of an inbound
 *                                 message (bounded, through safeFetch) into
 *                                 the object storage (purpose comm_media).
 * - comms.commitments_overdue  → hourly: marks due commitments as overdue
 *                                 and notifies their owners.
 *
 * Importing this file also registers the channel adapters and the storage
 * resolvers (upload target `comm_conversation`, access for `comm_media`).
 */

export const COMMS_COMMITMENTS_OVERDUE_JOB = 'comms.commitments_overdue';

interface PendingMedia {
  url: string;
  contentType: string;
  fileName?: string;
}

registerJobHandler<{ messageId: string }>(
  COMMS_PROCESS_INBOUND_JOB,
  async (ctx) => {
    const message = await prisma.commMessage.findUnique({
      where: { id: ctx.payload.messageId },
      include: { account: true, conversation: { select: { id: true, assignedToUserId: true } } },
    });
    if (!message) return { skipped: 'missing' };
    const meta = (message.providerMeta as Record<string, unknown> | null) ?? {};
    const pending = Array.isArray(meta.pendingMedia) ? (meta.pendingMedia as PendingMedia[]) : [];
    if (pending.length === 0) return { skipped: 'no_media' };

    const adapter = getChannelAdapter(message.account.provider);
    if (!hasMediaFetcher(adapter)) return { skipped: 'adapter_without_media' };

    const stored: string[] = [...message.mediaObjectIds];
    const errors: string[] = [];
    for (let i = 0; i < pending.length; i++) {
      if (ctx.signal.aborted) break;
      const item = pending[i];
      try {
        const file = await adapter.fetchMedia(message.account, item);
        const object = await saveGeneratedFile({
          createdBy: 'service:comms',
          purpose: 'comm_media',
          fileName: file.fileName,
          mimeType: file.contentType,
          source: { buffer: file.buffer },
          metadata: {
            accountId: message.accountId,
            conversationId: message.conversationId,
            messageId: message.id,
            provider: message.account.provider,
          },
        });
        stored.push(object.id);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : 'Error al descargar adjunto');
        ctx.log('media_failed', { index: i, error: errors[errors.length - 1] });
      }
      await ctx.setProgress(Math.round(((i + 1) / pending.length) * 100));
    }

    const { pendingMedia: _dropped, ...rest } = meta;
    void _dropped;
    await prisma.commMessage.update({
      where: { id: message.id },
      data: {
        mediaObjectIds: [...new Set(stored)],
        providerMeta: {
          ...rest,
          mediaErrors: errors.length ? errors : undefined,
        } as Prisma.InputJsonValue,
      },
    });
    const payload = {
      conversationId: message.conversationId,
      accountId: message.accountId,
      messageId: message.id,
      media: stored.length,
    };
    for (const key of new Set(message.account.teamKeys)) {
      await publishRealtime(REALTIME_CHANNELS.inbox(key), 'message_media', payload).catch(
        () => undefined
      );
    }
    if (message.conversation.assignedToUserId) {
      await publishRealtime(
        REALTIME_CHANNELS.user(message.conversation.assignedToUserId),
        'message_media',
        payload
      ).catch(() => undefined);
    }
    return { stored: stored.length, errors };
  },
  { timeoutMs: 5 * 60 * 1000 }
);

registerJobHandler(COMMS_COMMITMENTS_OVERDUE_JOB, async (ctx) => {
  const ids = await markOverdueCommitments();
  ctx.log('overdue', { count: ids.length });
  return { overdue: ids.length };
});

registerRecurringJob({
  type: COMMS_COMMITMENTS_OVERDUE_JOB,
  everyMs: 60 * 60 * 1000,
  priority: JOB_PRIORITY.maintenance,
});
