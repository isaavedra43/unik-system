import type { Prisma } from '@prisma/client';
import { isRfqConversationTagged } from '@/modules/purchases/purchases-types';

/**
 * Conversations of the inbox that belong to Compras, not to Ventas: requests
 * for quotation (tag `rfq:{id}`) and any conversation with a supplier (a
 * `Supplier` linked to the inbox contact, or a Zoho contact of type vendor).
 * The radar, the timeline touch and the opportunities never treat them as a
 * customer conversation.
 */

type Db = Pick<Prisma.TransactionClient, 'supplier' | 'contact'>;

export interface ConversationRef {
  id: string;
  tags: readonly string[];
  contactId: string;
  zohoContactId?: string | null;
}

export function isRfqConversation(tags: readonly string[]): boolean {
  return isRfqConversationTagged(tags);
}

/** Ids of the conversations (of `rows`) held with suppliers. */
export async function supplierConversationIds(
  db: Db,
  rows: readonly ConversationRef[]
): Promise<Set<string>> {
  const ids = new Set<string>();
  const rest: ConversationRef[] = [];
  for (const row of rows) {
    if (isRfqConversation(row.tags)) ids.add(row.id);
    else rest.push(row);
  }
  if (rest.length === 0) return ids;
  const contactIds = [...new Set(rest.map((row) => row.contactId))];
  const zohoIds = [
    ...new Set(rest.map((row) => row.zohoContactId).filter((id): id is string => Boolean(id))),
  ];
  const [suppliers, vendors] = await Promise.all([
    db.supplier.findMany({
      where: { commContactId: { in: contactIds } },
      select: { commContactId: true },
    }),
    zohoIds.length > 0
      ? db.contact.findMany({
          where: { zohoContactId: { in: zohoIds }, contactType: 'vendor' },
          select: { zohoContactId: true },
        })
      : Promise.resolve([] as Array<{ zohoContactId: string }>),
  ]);
  const supplierContacts = new Set(suppliers.map((row) => row.commContactId));
  const vendorContacts = new Set(vendors.map((row) => row.zohoContactId));
  for (const row of rest) {
    if (
      supplierContacts.has(row.contactId) ||
      (row.zohoContactId && vendorContacts.has(row.zohoContactId))
    )
      ids.add(row.id);
  }
  return ids;
}
