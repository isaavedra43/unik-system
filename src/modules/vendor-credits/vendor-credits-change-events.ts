import { Prisma } from '@prisma/client';
import { VENDOR_CREDIT_ENTITY_TYPE } from '@/modules/vendor-credits/permissions';
import { recordEntityChange, type ChangeFieldSpec } from '@/modules/notifications/entity-change-service';

/**
 * Change detection for nota de créditos ("seguimiento"). Called by the normalizer
 * inside its transaction with the row before and after the upsert.
 */

export const VENDOR_CREDIT_CHANGE_SELECT = {
  id: true,
  vendorCreditNumber: true,
  status: true,
  total: true,
  balance: true,
  vendorName: true,
} satisfies Prisma.VendorCreditSelect;

export type VendorCreditChangeSnapshot = Prisma.VendorCreditGetPayload<{ select: typeof VENDOR_CREDIT_CHANGE_SELECT }>;

export const VENDOR_CREDIT_CHANGE_FIELDS: ReadonlyArray<ChangeFieldSpec<VendorCreditChangeSnapshot>> = [
  { key: 'status', label: 'Estado' },
  { key: 'total', label: 'Total' },
  { key: 'balance', label: 'Saldo' },
  { key: 'vendorName', label: 'Proveedor' },
];

export async function recordVendorCreditChange(
  tx: Prisma.TransactionClient,
  input: {
    before: VendorCreditChangeSnapshot | null;
    after: VendorCreditChangeSnapshot;
    sourceSnapshotId: string;
    sourceRemoteModifiedAt: Date | null;
    actorUserId?: string | null;
  }
): Promise<void> {
  await recordEntityChange(tx, {
    entityType: VENDOR_CREDIT_ENTITY_TYPE,
    entityId: input.after.id,
    label: `Nota de crédito ${input.after.vendorCreditNumber ?? input.after.id.slice(-6)}`,
    url: `/app/vendor-credits/${input.after.id}`,
    sourceSnapshotId: input.sourceSnapshotId,
    sourceRemoteModifiedAt: input.sourceRemoteModifiedAt,
    before: input.before,
    after: input.after,
    fields: VENDOR_CREDIT_CHANGE_FIELDS,
    actorUserId: input.actorUserId ?? null,
    metadata: { number: input.after.vendorCreditNumber ?? null },
  });
}
