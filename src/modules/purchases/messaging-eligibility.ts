import type { Prisma } from '@prisma/client';
import { normalizePhone } from '@/modules/comms/normalize';
import type { MessagingChannelType } from './purchases-types';

/**
 * Whether Compras may write first to a supplier or candidate by a messaging
 * channel (RFQ invitations, purchase orders):
 *
 * - WhatsApp only accepts a business-initiated message outside the 24-hour
 *   customer service window through an approved template; without one the
 *   message is not sent (it would be rejected and the invitation lost).
 * - A Sourcing Lab candidate was found on the web and never agreed to receive
 *   messages: it is contacted by messaging only with an `opted_in` consent
 *   record (otherwise by phone or e-mail, or after promoting it to supplier).
 */

export const WHATSAPP_SERVICE_WINDOW_MS = 24 * 60 * 60_000;

type Db = Pick<Prisma.TransactionClient, 'commContact' | 'commConversation' | 'consentRecord'>;

export async function contactForAddress(db: Pick<Db, 'commContact'>, channel: MessagingChannelType, to: string) {
  if (channel === 'telegram') return db.commContact.findFirst({ where: { telegramId: to.trim() } });
  const phone = normalizePhone(to);
  if (!phone) return null;
  return db.commContact.findFirst({ where: { phone } });
}

/** An inbound message of the contact on this account in the last 24 hours. */
export async function whatsappWindowOpen(db: Db, input: { accountId: string; to: string; now: Date }): Promise<boolean> {
  const contact = await contactForAddress(db, 'whatsapp', input.to);
  if (!contact) return false;
  const conversation = await db.commConversation.findFirst({
    where: {
      accountId: input.accountId,
      contactId: contact.id,
      lastInboundAt: { gte: new Date(input.now.getTime() - WHATSAPP_SERVICE_WINDOW_MS) },
    },
    select: { id: true },
  });
  return Boolean(conversation);
}

/** Latest consent of the contact for the channel is `opted_in`. */
export async function hasMessagingConsent(db: Db, input: { channel: MessagingChannelType; to: string }): Promise<boolean> {
  const contact = await contactForAddress(db, input.channel, input.to);
  if (!contact) return false;
  const last = await db.consentRecord.findFirst({
    where: { contactId: contact.id, channel: input.channel },
    orderBy: { recordedAt: 'desc' },
  });
  return last?.status === 'opted_in';
}
