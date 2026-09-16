import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { registerJobHandler, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import { publishRealtime, REALTIME_CHANNELS } from '@/modules/realtime/realtime-service';
import { isKnownPermission } from '@/modules/auth/permissions';
import { saveGeneratedFile } from '@/modules/storage/storage-service';
import {
  RFQ_CONVERSATION_TAG_PREFIX,
  isRfqConversationTagged,
} from '@/modules/purchases/purchases-types';
import { getChannelAdapter, hasMediaFetcher } from './adapters';
import { markOverdueCommitments } from './commitments-service';
import { COMMS_MESSAGE_FANOUT_JOB, COMMS_PROCESS_INBOUND_JOB } from './comms-service';
import './comms-storage';

/**
 * Background jobs owned by the communications module.
 *
 * - comms.process_inbound      → downloads provider media of an inbound
 *                                 message (bounded, through safeFetch) into
 *                                 the object storage (purpose comm_media).
 * - comms.commitments_overdue  → hourly: marks due commitments as overdue
 *                                 and notifies their owners.
 * - comms.message_fanout       → per stored message (inbound, or outbound after
 *                                 sending; dedupe `fanout:{messageId}`): the CRM
 *                                 touch of the conversation's opportunities and,
 *                                 for inbound replies in conversations tagged
 *                                 `rfq:*`, the RFQ reply interpretation.
 *
 * Importing this file also registers the channel adapters and the storage
 * resolvers (upload target `comm_conversation`, access for `comm_media`).
 */

export const COMMS_COMMITMENTS_OVERDUE_JOB = 'comms.commitments_overdue';

/**
 * Conversations of a request for quotation carry the tag `rfq:{rfqId}`.
 *
 * Reexportado, NO copiado: la etiqueta es un único contrato con Compras, que es
 * quien la escribe. `purchases-types` es un módulo puro (sin Prisma ni registro
 * de permisos), así que importarlo aquí no carga el módulo de compras — sólo los
 * RECEPTORES se cargan bajo demanda, más abajo. Un literal duplicado dejaría de
 * encolar la interpretación de las respuestas de proveedores sin ningún error.
 */
export { RFQ_CONVERSATION_TAG_PREFIX };

/** Receivers of the fan-out (loaded on demand so messaging does not load CRM or purchases). */
export interface MessageFanoutDeps {
  touchConversation(messageId: string): Promise<unknown>;
  interpretRfqReplyIfTagged(messageId: string): Promise<unknown>;
}

/** Result of a receiver whose module is not installed (its permissions are not registered): nothing to retry. */
export const FANOUT_RECEIVER_NOT_INSTALLED = { skipped: 'module_not_installed' } as const;

export const defaultMessageFanoutDeps: MessageFanoutDeps = {
  async touchConversation(messageId) {
    // Loading a module whose permission keys are not in the registry throws at import: never retry for that.
    if (!isKnownPermission('crm.view')) return FANOUT_RECEIVER_NOT_INSTALLED;
    const { touchConversation } = await import('@/modules/crm/opportunities-service');
    return touchConversation(messageId);
  },
  async interpretRfqReplyIfTagged(messageId) {
    if (!isKnownPermission('purchases.view')) return FANOUT_RECEIVER_NOT_INSTALLED;
    const { interpretRfqReplyIfTagged } = await import('@/modules/purchases/rfq-service');
    return interpretRfqReplyIfTagged(messageId);
  },
};

export interface MessageFanoutResult {
  messageId: string;
  skipped?: 'missing';
  crm: 'done' | 'skipped';
  rfq: 'done' | 'not_tagged' | 'outbound';
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs both receivers even when one fails, then throws so the queue retries the
 * job; both receivers are idempotent per message (the CRM touch through its
 * command ledger).
 */
export async function runMessageFanout(
  messageId: string,
  deps: MessageFanoutDeps = defaultMessageFanoutDeps
): Promise<MessageFanoutResult> {
  const message = await prisma.commMessage.findUnique({
    where: { id: messageId },
    select: { id: true, direction: true, conversation: { select: { tags: true } } },
  });
  if (!message) return { messageId, skipped: 'missing', crm: 'skipped', rfq: 'not_tagged' };
  const errors: string[] = [];
  const tagged = isRfqConversationTagged(message.conversation.tags);
  const rfq: MessageFanoutResult['rfq'] = !tagged
    ? 'not_tagged'
    : message.direction === 'inbound'
      ? 'done'
      : 'outbound';
  if (rfq === 'done') {
    try {
      await deps.interpretRfqReplyIfTagged(messageId);
    } catch (error) {
      errors.push(`RFQ: ${describeError(error)}`);
    }
  }
  try {
    await deps.touchConversation(messageId);
  } catch (error) {
    errors.push(`CRM: ${describeError(error)}`);
  }
  if (errors.length > 0) {
    throw new Error(`Fan-out incompleto del mensaje ${messageId}: ${errors.join(' | ')}`);
  }
  return { messageId, crm: 'done', rfq };
}

registerJobHandler<{ messageId: string }>(
  COMMS_MESSAGE_FANOUT_JOB,
  async (ctx) => {
    const result = await runMessageFanout(ctx.payload.messageId);
    ctx.log('fanout', { crm: result.crm, rfq: result.rfq, skipped: result.skipped ?? null });
    return result;
  },
  { timeoutMs: 2 * 60 * 1000 }
);

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
