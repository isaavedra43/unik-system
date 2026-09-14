import { Prisma } from '@prisma/client';
import { CONTACT_ENTITY_TYPE_CUSTOMER, CONTACT_ENTITY_TYPE_VENDOR } from '@/modules/contacts/permissions';
import { recordEntityChange, type ChangeFieldSpec } from '@/modules/notifications/entity-change-service';

/**
 * Change detection for contacts ("seguimiento"). The watch entity type depends
 * on the contact type (customers and vendors are followed separately).
 */

export const CONTACT_CHANGE_SELECT = {
  id: true,
  contactType: true,
  contactName: true,
  companyName: true,
  status: true,
  outstandingReceivable: true,
  outstandingPayable: true,
  unusedCreditsReceivable: true,
  paymentTermsLabel: true,
  primaryEmail: true,
  primaryPhone: true,
  mobile: true,
  creditLimitExceededAmount: true,
  ownerName: true,
} satisfies Prisma.ContactSelect;

export type ContactChangeSnapshot = Prisma.ContactGetPayload<{ select: typeof CONTACT_CHANGE_SELECT }>;

export const CONTACT_CHANGE_FIELDS: ReadonlyArray<ChangeFieldSpec<ContactChangeSnapshot>> = [
  { key: 'status', label: 'Estado' },
  { key: 'outstandingReceivable', label: 'Por cobrar' },
  { key: 'outstandingPayable', label: 'Por pagar' },
  { key: 'unusedCreditsReceivable', label: 'Créditos sin usar' },
  { key: 'creditLimitExceededAmount', label: 'Límite de crédito excedido' },
  { key: 'paymentTermsLabel', label: 'Condiciones de pago' },
  { key: 'contactName', label: 'Nombre' },
  { key: 'companyName', label: 'Empresa' },
  { key: 'primaryEmail', label: 'Email' },
  { key: 'primaryPhone', label: 'Teléfono' },
  { key: 'mobile', label: 'Celular' },
  { key: 'ownerName', label: 'Responsable' },
];

export function contactWatchEntityType(contactType: string | null | undefined): string {
  return (contactType ?? '').toLowerCase() === 'vendor'
    ? CONTACT_ENTITY_TYPE_VENDOR
    : CONTACT_ENTITY_TYPE_CUSTOMER;
}

export async function recordContactChange(
  tx: Prisma.TransactionClient,
  input: {
    before: ContactChangeSnapshot | null;
    after: ContactChangeSnapshot;
    sourceSnapshotId: string;
    sourceRemoteModifiedAt: Date | null;
    actorUserId?: string | null;
  }
): Promise<void> {
  const entityType = contactWatchEntityType(input.after.contactType);
  const isVendor = entityType === CONTACT_ENTITY_TYPE_VENDOR;
  const name = input.after.contactName ?? input.after.companyName ?? input.after.id.slice(-6);
  await recordEntityChange(tx, {
    entityType,
    entityId: input.after.id,
    label: `${isVendor ? 'Proveedor' : 'Cliente'} ${name}`,
    url: `/app/contacts/${isVendor ? 'vendors' : 'customers'}/${input.after.id}`,
    sourceSnapshotId: input.sourceSnapshotId,
    sourceRemoteModifiedAt: input.sourceRemoteModifiedAt,
    before: input.before,
    after: input.after,
    fields: CONTACT_CHANGE_FIELDS,
    actorUserId: input.actorUserId ?? null,
    metadata: { contactName: name },
  });
}
