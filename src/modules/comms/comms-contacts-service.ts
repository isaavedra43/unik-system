import { Prisma, type CommContact } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { assertInboxAssign, assertInboxUse } from './comms-access';
import { CommsError, assertFound } from './comms-errors';
import { emailDomain, normalizeEmail, normalizeName, normalizePhone } from './normalize';

/**
 * Communication contacts: one record per person/company reachable through the
 * inbox. Duplicate detection is REVIEWABLE: possible duplicates are flagged
 * `pending` with the suspected match in `duplicateOfId`; a human confirms
 * (merge) or dismisses. Nothing is merged automatically.
 */

export const contactInputSchema = z.object({
  displayName: z.string().min(1).max(160),
  phone: z.string().max(40).nullable().optional(),
  telegramId: z.string().max(64).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  zohoContactId: z.string().max(80).nullable().optional(),
  tags: z.array(z.string().min(1).max(40)).max(30).optional(),
});

export type ContactInput = z.infer<typeof contactInputSchema>;

export interface CommContactDTO {
  id: string;
  displayName: string;
  phone: string | null;
  telegramId: string | null;
  email: string | null;
  zohoContactId: string | null;
  tags: string[];
  duplicateOfId: string | null;
  duplicateReviewStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toContactDTO(contact: CommContact): CommContactDTO {
  return {
    id: contact.id,
    displayName: contact.displayName,
    phone: contact.phone,
    telegramId: contact.telegramId,
    email: contact.email,
    zohoContactId: contact.zohoContactId,
    tags: contact.tags,
    duplicateOfId: contact.duplicateOfId,
    duplicateReviewStatus: contact.duplicateReviewStatus,
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
  };
}

function normalizeInput(
  input: Partial<ContactInput>
): Prisma.CommContactUncheckedCreateInput | Prisma.CommContactUncheckedUpdateInput {
  const data: Record<string, unknown> = {};
  if (input.displayName !== undefined) data.displayName = input.displayName.trim();
  if (input.phone !== undefined) {
    if (input.phone && !normalizePhone(input.phone)) throw new CommsError('Teléfono inválido', 400);
    data.phone = input.phone ? normalizePhone(input.phone) : null;
  }
  if (input.email !== undefined) {
    if (input.email && !normalizeEmail(input.email)) throw new CommsError('Correo inválido', 400);
    data.email = input.email ? normalizeEmail(input.email) : null;
  }
  if (input.telegramId !== undefined)
    data.telegramId = input.telegramId ? input.telegramId.trim() : null;
  if (input.zohoContactId !== undefined) data.zohoContactId = input.zohoContactId || null;
  if (input.tags !== undefined)
    data.tags = [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))];
  return data as Prisma.CommContactUncheckedCreateInput;
}

/**
 * Finds contacts that look like the same person: same E.164 phone, same
 * normalized email, or same normalized name within the same email domain.
 * Returns candidates ordered by strength (phone > email > name+domain).
 */
export async function findDuplicateCandidates(
  contact: Pick<CommContact, 'id' | 'displayName' | 'phone' | 'email'>
): Promise<Array<{ contact: CommContact; reason: 'phone' | 'email' | 'name_domain' }>> {
  const or: Prisma.CommContactWhereInput[] = [];
  const phone = normalizePhone(contact.phone);
  const email = normalizeEmail(contact.email);
  const domain = emailDomain(contact.email);
  if (phone) or.push({ phone });
  if (email) or.push({ email });
  if (domain) or.push({ email: { endsWith: `@${domain}` } });
  if (or.length === 0) return [];
  const rows = await prisma.commContact.findMany({
    where: {
      id: { not: contact.id },
      OR: or,
      NOT: { duplicateReviewStatus: 'confirmed' },
    },
    take: 20,
  });
  const nameKey = normalizeName(contact.displayName);
  const out: Array<{ contact: CommContact; reason: 'phone' | 'email' | 'name_domain' }> = [];
  for (const row of rows) {
    if (phone && row.phone === phone) out.push({ contact: row, reason: 'phone' });
    else if (email && row.email === email) out.push({ contact: row, reason: 'email' });
    else if (
      domain &&
      nameKey &&
      normalizeName(row.displayName) === nameKey &&
      emailDomain(row.email) === domain
    ) {
      out.push({ contact: row, reason: 'name_domain' });
    }
  }
  const weight = { phone: 0, email: 1, name_domain: 2 };
  return out.sort((a, b) => weight[a.reason] - weight[b.reason]);
}

/** Flags the contact for review when a probable duplicate exists. Never merges. */
export async function flagDuplicatesForReview(contactId: string): Promise<CommContact | null> {
  const contact = await prisma.commContact.findUnique({ where: { id: contactId } });
  if (!contact) return null;
  if (contact.duplicateReviewStatus === 'confirmed' || contact.duplicateReviewStatus === 'pending')
    return contact;
  const candidates = await findDuplicateCandidates(contact);
  if (candidates.length === 0) return contact;
  return prisma.commContact.update({
    where: { id: contactId },
    data: { duplicateOfId: candidates[0].contact.id, duplicateReviewStatus: 'pending' },
  });
}

/** Best-effort link to the synchronized Zoho contact by phone or email. */
async function linkZohoContact(phone: string | null, email: string | null): Promise<string | null> {
  try {
    if (phone) {
      const last10 = phone.replace(/\D/g, '').slice(-10);
      if (last10.length === 10) {
        const byPhone = await prisma.contact.findFirst({
          where: { OR: [{ primaryPhone: { contains: last10 } }, { mobile: { contains: last10 } }] },
          select: { zohoContactId: true },
        });
        if (byPhone) return byPhone.zohoContactId;
      }
    }
    if (email) {
      const byEmail = await prisma.contact.findFirst({
        where: { primaryEmail: { equals: email, mode: 'insensitive' } },
        select: { zohoContactId: true },
      });
      if (byEmail) return byEmail.zohoContactId;
    }
  } catch {
    // Linking is optional; never block the inbox on it.
  }
  return null;
}

/** Finds or creates the contact behind an inbound message (phone for Twilio, chat id for Telegram). */
export async function upsertContactForInbound(
  provider: string,
  from: string,
  fromName?: string
): Promise<CommContact> {
  if (provider === 'telegram') {
    const existing = await prisma.commContact.findFirst({ where: { telegramId: from } });
    if (existing) {
      if (fromName && existing.displayName === from) {
        return prisma.commContact.update({
          where: { id: existing.id },
          data: { displayName: fromName },
        });
      }
      return existing;
    }
    const created = await prisma.commContact.create({
      data: { displayName: fromName?.trim() || `Telegram ${from}`, telegramId: from },
    });
    return (await flagDuplicatesForReview(created.id)) ?? created;
  }
  const phone = normalizePhone(from) ?? from;
  const existing = await prisma.commContact.findFirst({
    where: { phone },
    orderBy: { createdAt: 'asc' },
  });
  if (existing) {
    if (fromName && existing.displayName === phone) {
      return prisma.commContact.update({
        where: { id: existing.id },
        data: { displayName: fromName },
      });
    }
    return existing;
  }
  const zohoContactId = await linkZohoContact(phone, null);
  const created = await prisma.commContact.create({
    data: { displayName: fromName?.trim() || phone, phone, zohoContactId },
  });
  return (await flagDuplicatesForReview(created.id)) ?? created;
}

export async function createContact(
  actor: CurrentUser,
  input: ContactInput
): Promise<CommContactDTO> {
  assertInboxUse(actor);
  const data = normalizeInput(input) as Prisma.CommContactUncheckedCreateInput;
  if (!data.phone && !data.telegramId && !data.email) {
    throw new CommsError('El contacto necesita teléfono, correo o Telegram', 400);
  }
  if (!data.zohoContactId) {
    data.zohoContactId = await linkZohoContact(
      (data.phone as string | null) ?? null,
      (data.email as string | null) ?? null
    );
  }
  const created = await prisma.commContact.create({ data });
  const flagged = (await flagDuplicatesForReview(created.id)) ?? created;
  return toContactDTO(flagged);
}

export async function updateContact(
  actor: CurrentUser,
  id: string,
  patch: Partial<ContactInput>
): Promise<CommContactDTO> {
  assertInboxUse(actor);
  assertFound(
    await prisma.commContact.findUnique({ where: { id }, select: { id: true } }),
    'Contacto no encontrado'
  );
  const updated = await prisma.commContact.update({
    where: { id },
    data: normalizeInput(patch) as Prisma.CommContactUncheckedUpdateInput,
  });
  const flagged = (await flagDuplicatesForReview(updated.id)) ?? updated;
  return toContactDTO(flagged);
}

export async function getContact(actor: CurrentUser, id: string): Promise<CommContactDTO> {
  assertInboxUse(actor);
  const contact = assertFound(
    await prisma.commContact.findUnique({ where: { id } }),
    'Contacto no encontrado'
  );
  return toContactDTO(contact);
}

export async function listContacts(
  actor: CurrentUser,
  filters: { search?: string; page?: number; pageSize?: number } = {}
): Promise<{ items: CommContactDTO[]; total: number; page: number; pageSize: number }> {
  assertInboxUse(actor);
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));
  const where: Prisma.CommContactWhereInput = { NOT: { duplicateReviewStatus: 'confirmed' } };
  if (filters.search?.trim()) {
    const q = filters.search.trim();
    where.OR = [
      { displayName: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q.replace(/\s+/g, '') } },
      { email: { contains: q, mode: 'insensitive' } },
      { telegramId: { contains: q } },
    ];
  }
  const [items, total] = await Promise.all([
    prisma.commContact.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.commContact.count({ where }),
  ]);
  return { items: items.map(toContactDTO), total, page, pageSize };
}

export interface DuplicateCandidateDTO {
  contact: CommContactDTO;
  suspected: CommContactDTO | null;
  reasons: string[];
}

export async function listPendingDuplicates(actor: CurrentUser): Promise<DuplicateCandidateDTO[]> {
  assertInboxUse(actor);
  const pending = await prisma.commContact.findMany({
    where: { duplicateReviewStatus: 'pending' },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });
  const out: DuplicateCandidateDTO[] = [];
  for (const contact of pending) {
    const suspected = contact.duplicateOfId
      ? await prisma.commContact.findUnique({ where: { id: contact.duplicateOfId } })
      : null;
    const reasons: string[] = [];
    if (suspected) {
      if (suspected.phone && suspected.phone === contact.phone) reasons.push('Mismo teléfono');
      if (suspected.email && suspected.email === contact.email) reasons.push('Mismo correo');
      if (normalizeName(suspected.displayName) === normalizeName(contact.displayName))
        reasons.push('Mismo nombre');
      if (
        emailDomain(suspected.email) &&
        emailDomain(suspected.email) === emailDomain(contact.email)
      )
        reasons.push('Mismo dominio');
    }
    out.push({
      contact: toContactDTO(contact),
      suspected: suspected ? toContactDTO(suspected) : null,
      reasons,
    });
  }
  return out;
}

/**
 * Confirms a duplicate: conversations, commitments, consents and requests of
 * `duplicateId` move to the survivor; the survivor gains any identifier it
 * was missing; the duplicate stays as a confirmed pointer (never deleted).
 */
export async function mergeDuplicate(
  actor: CurrentUser,
  duplicateId: string,
  survivorId?: string
): Promise<{
  survivor: CommContactDTO;
  moved: { conversations: number; commitments: number; consents: number; requests: number };
}> {
  assertInboxAssign(actor);
  const duplicate = assertFound(
    await prisma.commContact.findUnique({ where: { id: duplicateId } }),
    'Contacto no encontrado'
  );
  const targetId = survivorId ?? duplicate.duplicateOfId;
  if (!targetId || targetId === duplicateId)
    throw new CommsError('Indica con qué contacto se fusiona', 400);
  const survivor = assertFound(
    await prisma.commContact.findUnique({ where: { id: targetId } }),
    'Contacto sobreviviente no encontrado'
  );
  if (survivor.duplicateReviewStatus === 'confirmed') {
    throw new CommsError('El contacto sobreviviente ya fue fusionado en otro', 409);
  }

  const conversations = await prisma.commConversation.updateMany({
    where: { contactId: duplicateId },
    data: { contactId: survivor.id },
  });
  const commitments = await prisma.commitment.updateMany({
    where: { contactId: duplicateId },
    data: { contactId: survivor.id },
  });
  const consents = await prisma.consentRecord.updateMany({
    where: { contactId: duplicateId },
    data: { contactId: survivor.id },
  });
  const requests = await prisma.internalRequest.updateMany({
    where: { contactId: duplicateId },
    data: { contactId: survivor.id },
  });

  const fill: Prisma.CommContactUpdateInput = {
    tags: [...new Set([...survivor.tags, ...duplicate.tags])],
  };
  if (!survivor.phone && duplicate.phone) fill.phone = duplicate.phone;
  if (!survivor.email && duplicate.email) fill.email = duplicate.email;
  if (!survivor.telegramId && duplicate.telegramId) fill.telegramId = duplicate.telegramId;
  if (!survivor.zohoContactId && duplicate.zohoContactId)
    fill.zohoContactId = duplicate.zohoContactId;
  const updatedSurvivor = await prisma.commContact.update({
    where: { id: survivor.id },
    data: fill,
  });

  await prisma.commContact.update({
    where: { id: duplicateId },
    data: {
      duplicateOfId: survivor.id,
      duplicateReviewStatus: 'confirmed',
      // Free the unique-ish identifiers so future lookups resolve the survivor.
      phone: null,
      telegramId: null,
      email: null,
    },
  });
  // Contacts that pointed at the merged duplicate now point at the survivor.
  await prisma.commContact.updateMany({
    where: { duplicateOfId: duplicateId, duplicateReviewStatus: 'pending' },
    data: { duplicateOfId: survivor.id },
  });

  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'comms.contact.merged',
    targetType: 'comm_contact',
    targetId: survivor.id,
    metadata: { duplicateId, conversations: conversations.count, commitments: commitments.count },
  });
  return {
    survivor: toContactDTO(updatedSurvivor),
    moved: {
      conversations: conversations.count,
      commitments: commitments.count,
      consents: consents.count,
      requests: requests.count,
    },
  };
}

export async function dismissDuplicate(
  actor: CurrentUser,
  contactId: string
): Promise<CommContactDTO> {
  assertInboxAssign(actor);
  const contact = assertFound(
    await prisma.commContact.findUnique({ where: { id: contactId } }),
    'Contacto no encontrado'
  );
  if (contact.duplicateReviewStatus === 'confirmed')
    throw new CommsError('El contacto ya fue fusionado', 409);
  const updated = await prisma.commContact.update({
    where: { id: contactId },
    data: { duplicateOfId: null, duplicateReviewStatus: 'dismissed' },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'comms.contact.duplicate_dismissed',
    targetType: 'comm_contact',
    targetId: contactId,
  });
  return toContactDTO(updated);
}
