import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { normalizePhone } from './normalize';
import { visibleAccountsWhere } from './comms-access';
import { CommsError } from './comms-errors';

/**
 * Resolves "who" the assistant should message or call from a loose reference
 * (name, phone, Zoho id, inbox contact id) and finds the right inbox
 * conversation / account. Shared by messaging, calling and quoting tools.
 */

export interface ResolvedContact {
  commContactId: string | null;
  displayName: string;
  phone: string | null;
  email: string | null;
  zohoContactId: string | null;
  /** How the match was made (for the approval card). */
  matchedBy: 'inbox_contact_id' | 'phone' | 'zoho_id' | 'inbox_name' | 'zoho_name';
  candidates?: Array<{ name: string; phone: string | null }>;
}

function looksLikePhone(value: string): boolean {
  return /^[+\d][\d\s().-]{6,}$/.test(value.trim());
}

/**
 * Finds a contact. Prefers inbox contacts (they already have a channel); falls
 * back to the Zoho contact catalog (customers with a phone). Throws with a
 * helpful message when nothing or too many things match.
 */
export async function resolveContact(reference: string): Promise<ResolvedContact> {
  const ref = reference.trim();
  if (!ref) throw new CommsError('Indica a quién (nombre, teléfono o id de contacto)', 400);

  const byId = await prisma.commContact.findUnique({ where: { id: ref } }).catch(() => null);
  if (byId) return { commContactId: byId.id, displayName: byId.displayName, phone: byId.phone, email: byId.email, zohoContactId: byId.zohoContactId, matchedBy: 'inbox_contact_id' };

  if (looksLikePhone(ref)) {
    const phone = normalizePhone(ref);
    if (phone) {
      const c = await prisma.commContact.findFirst({ where: { phone }, orderBy: { updatedAt: 'desc' } });
      if (c) return { commContactId: c.id, displayName: c.displayName, phone: c.phone, email: c.email, zohoContactId: c.zohoContactId, matchedBy: 'phone' };
      const z = await prisma.contact.findFirst({ where: { OR: [{ primaryPhone: { contains: phone.slice(-10) } }, { mobile: { contains: phone.slice(-10) } }] } });
      return { commContactId: null, displayName: z?.contactName ?? z?.companyName ?? phone, phone, email: z?.primaryEmail ?? null, zohoContactId: z?.zohoContactId ?? null, matchedBy: 'phone' };
    }
  }

  const byZoho = await prisma.commContact.findFirst({ where: { zohoContactId: ref } });
  if (byZoho) return { commContactId: byZoho.id, displayName: byZoho.displayName, phone: byZoho.phone, email: byZoho.email, zohoContactId: byZoho.zohoContactId, matchedBy: 'zoho_id' };

  const inboxMatches = await prisma.commContact.findMany({
    where: { displayName: { contains: ref, mode: 'insensitive' } },
    orderBy: { updatedAt: 'desc' },
    take: 5,
  });
  if (inboxMatches.length === 1 || (inboxMatches.length > 1 && inboxMatches[0].displayName.toLowerCase() === ref.toLowerCase())) {
    const c = inboxMatches[0];
    return { commContactId: c.id, displayName: c.displayName, phone: c.phone, email: c.email, zohoContactId: c.zohoContactId, matchedBy: 'inbox_name', candidates: inboxMatches.slice(1).map((m) => ({ name: m.displayName, phone: m.phone })) };
  }
  if (inboxMatches.length > 1) {
    throw new CommsError(`Hay ${inboxMatches.length} contactos que coinciden con "${ref}": ${inboxMatches.map((m) => `${m.displayName}${m.phone ? ` (${m.phone})` : ''}`).join(', ')}. Indica cuál.`, 409);
  }

  const zohoMatches = await prisma.contact.findMany({
    where: { OR: [{ contactName: { contains: ref, mode: 'insensitive' } }, { companyName: { contains: ref, mode: 'insensitive' } }] },
    orderBy: { contactName: 'asc' },
    take: 5,
  });
  if (zohoMatches.length === 0) throw new CommsError(`No encontré ningún contacto que coincida con "${ref}" ni en la bandeja ni en Zoho.`, 404);
  if (zohoMatches.length > 1 && !zohoMatches.some((m) => (m.contactName ?? '').toLowerCase() === ref.toLowerCase())) {
    throw new CommsError(`Hay ${zohoMatches.length} clientes en Zoho que coinciden con "${ref}": ${zohoMatches.map((m) => m.contactName ?? m.companyName).join(', ')}. Indica cuál.`, 409);
  }
  const z = zohoMatches.find((m) => (m.contactName ?? '').toLowerCase() === ref.toLowerCase()) ?? zohoMatches[0];
  const phone = normalizePhone(z.primaryPhone ?? z.mobile ?? null);
  const linked = phone ? await prisma.commContact.findFirst({ where: { OR: [{ phone }, { zohoContactId: z.zohoContactId }] } }) : await prisma.commContact.findFirst({ where: { zohoContactId: z.zohoContactId } });
  return {
    commContactId: linked?.id ?? null,
    displayName: linked?.displayName ?? z.contactName ?? z.companyName ?? ref,
    phone: linked?.phone ?? phone,
    email: linked?.email ?? z.primaryEmail ?? null,
    zohoContactId: z.zohoContactId,
    matchedBy: 'zoho_name',
  };
}

export type PreferredChannel = 'whatsapp' | 'sms' | 'telegram' | 'any';

const PROVIDER_BY_CHANNEL: Record<Exclude<PreferredChannel, 'any'>, string> = {
  whatsapp: 'twilio_whatsapp',
  sms: 'twilio_sms',
  telegram: 'telegram',
};

/**
 * Picks the inbox conversation to use for a contact (newest on the preferred
 * channel among the accounts the actor can access) or the account to start one.
 */
export async function pickConversationForContact(
  actor: CurrentUser,
  contact: ResolvedContact,
  channel: PreferredChannel = 'any'
): Promise<{ conversationId: string | null; accountId: string; provider: string; lastInboundAt: Date | null }> {
  const accountWhere = { ...visibleAccountsWhere(actor), status: 'active' as const };
  if (contact.commContactId) {
    const conv = await prisma.commConversation.findFirst({
      where: {
        contactId: contact.commContactId,
        account: { ...accountWhere, ...(channel !== 'any' ? { provider: PROVIDER_BY_CHANNEL[channel] } : {}) },
      },
      orderBy: { lastMessageAt: 'desc' },
      include: { account: { select: { id: true, provider: true } } },
    });
    if (conv) return { conversationId: conv.id, accountId: conv.account.id, provider: conv.account.provider, lastInboundAt: conv.lastInboundAt };
  }
  const providers = channel === 'any' ? ['twilio_whatsapp', 'twilio_sms'] : [PROVIDER_BY_CHANNEL[channel]];
  const account = await prisma.commAccount.findFirst({
    where: { ...accountWhere, provider: { in: providers } },
    orderBy: [{ provider: 'asc' }, { label: 'asc' }],
    select: { id: true, provider: true },
  });
  if (!account) throw new CommsError(`No tienes una cuenta de ${channel === 'any' ? 'WhatsApp/SMS' : channel} activa para escribirle a este contacto.`, 409);
  return { conversationId: null, accountId: account.id, provider: account.provider, lastInboundAt: null };
}

export function channelLabel(provider: string): string {
  if (provider === 'twilio_whatsapp') return 'WhatsApp';
  if (provider === 'twilio_sms') return 'SMS';
  if (provider === 'telegram') return 'Telegram';
  return provider;
}
