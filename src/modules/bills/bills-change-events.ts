import { Prisma } from '@prisma/client';
import { BILL_ENTITY_TYPE } from '@/modules/bills/permissions';
import { recordEntityChange, type ChangeFieldSpec } from '@/modules/notifications/entity-change-service';

/**
 * Change detection for factura de proveedors ("seguimiento"). Called by the normalizer
 * inside its transaction with the row before and after the upsert.
 */

export const BILL_CHANGE_SELECT = {
  id: true,
  billNumber: true,
  status: true,
  total: true,
  balance: true,
  dueDate: true,
  vendorName: true,
} satisfies Prisma.BillSelect;

export type BillChangeSnapshot = Prisma.BillGetPayload<{ select: typeof BILL_CHANGE_SELECT }>;

export const BILL_CHANGE_FIELDS: ReadonlyArray<ChangeFieldSpec<BillChangeSnapshot>> = [
  { key: 'status', label: 'Estado' },
  { key: 'total', label: 'Total' },
  { key: 'balance', label: 'Saldo' },
  { key: 'dueDate', label: 'Vence' },
  { key: 'vendorName', label: 'Proveedor' },
];

export async function recordBillChange(
  tx: Prisma.TransactionClient,
  input: {
    before: BillChangeSnapshot | null;
    after: BillChangeSnapshot;
    sourceSnapshotId: string;
    sourceRemoteModifiedAt: Date | null;
    actorUserId?: string | null;
  }
): Promise<void> {
  await recordEntityChange(tx, {
    entityType: BILL_ENTITY_TYPE,
    entityId: input.after.id,
    label: `Factura de proveedor ${input.after.billNumber ?? input.after.id.slice(-6)}`,
    url: `/app/bills/${input.after.id}`,
    sourceSnapshotId: input.sourceSnapshotId,
    sourceRemoteModifiedAt: input.sourceRemoteModifiedAt,
    before: input.before,
    after: input.after,
    fields: BILL_CHANGE_FIELDS,
    actorUserId: input.actorUserId ?? null,
    metadata: { number: input.after.billNumber ?? null },
  });
}
