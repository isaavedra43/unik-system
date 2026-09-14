import { Prisma } from '@prisma/client';
import { PURCHASE_ORDER_ENTITY_TYPE } from '@/modules/purchase-orders/permissions';
import { recordEntityChange, type ChangeFieldSpec } from '@/modules/notifications/entity-change-service';

/**
 * Change detection for orden de compras ("seguimiento"). Called by the normalizer
 * inside its transaction with the row before and after the upsert.
 */

export const PURCHASE_ORDER_CHANGE_SELECT = {
  id: true,
  purchaseOrderNumber: true,
  status: true,
  total: true,
  balance: true,
  deliveryDate: true,
  dueDate: true,
  vendorName: true,
} satisfies Prisma.PurchaseOrderSelect;

export type PurchaseOrderChangeSnapshot = Prisma.PurchaseOrderGetPayload<{ select: typeof PURCHASE_ORDER_CHANGE_SELECT }>;

export const PURCHASE_ORDER_CHANGE_FIELDS: ReadonlyArray<ChangeFieldSpec<PurchaseOrderChangeSnapshot>> = [
  { key: 'status', label: 'Estado' },
  { key: 'total', label: 'Total' },
  { key: 'balance', label: 'Saldo' },
  { key: 'deliveryDate', label: 'Fecha de entrega' },
  { key: 'dueDate', label: 'Vence' },
  { key: 'vendorName', label: 'Proveedor' },
];

export async function recordPurchaseOrderChange(
  tx: Prisma.TransactionClient,
  input: {
    before: PurchaseOrderChangeSnapshot | null;
    after: PurchaseOrderChangeSnapshot;
    sourceSnapshotId: string;
    sourceRemoteModifiedAt: Date | null;
    actorUserId?: string | null;
  }
): Promise<void> {
  await recordEntityChange(tx, {
    entityType: PURCHASE_ORDER_ENTITY_TYPE,
    entityId: input.after.id,
    label: `Orden de compra ${input.after.purchaseOrderNumber ?? input.after.id.slice(-6)}`,
    url: `/app/purchase-orders/${input.after.id}`,
    sourceSnapshotId: input.sourceSnapshotId,
    sourceRemoteModifiedAt: input.sourceRemoteModifiedAt,
    before: input.before,
    after: input.after,
    fields: PURCHASE_ORDER_CHANGE_FIELDS,
    actorUserId: input.actorUserId ?? null,
    metadata: { number: input.after.purchaseOrderNumber ?? null },
  });
}
