import { Prisma } from '@prisma/client';
import { PRODUCT_ENTITY_TYPE } from '@/modules/products/permissions';
import { recordEntityChange, type ChangeFieldSpec } from '@/modules/notifications/entity-change-service';

/**
 * Change detection for productos ("seguimiento"). Called by the normalizer
 * inside its transaction with the row before and after the upsert.
 */

export const PRODUCT_CHANGE_SELECT = {
  id: true,
  name: true,
  status: true,
  rate: true,
  purchaseRate: true,
  stockOnHand: true,
  availableStock: true,
  reorderLevel: true,
  sku: true,
} satisfies Prisma.ProductSelect;

export type ProductChangeSnapshot = Prisma.ProductGetPayload<{ select: typeof PRODUCT_CHANGE_SELECT }>;

export const PRODUCT_CHANGE_FIELDS: ReadonlyArray<ChangeFieldSpec<ProductChangeSnapshot>> = [
  { key: 'status', label: 'Estado' },
  { key: 'rate', label: 'Precio' },
  { key: 'purchaseRate', label: 'Costo' },
  { key: 'stockOnHand', label: 'Existencia' },
  { key: 'availableStock', label: 'Disponible' },
  { key: 'reorderLevel', label: 'Punto de reorden' },
  { key: 'name', label: 'Nombre' },
  { key: 'sku', label: 'SKU' },
];

export async function recordProductChange(
  tx: Prisma.TransactionClient,
  input: {
    before: ProductChangeSnapshot | null;
    after: ProductChangeSnapshot;
    sourceSnapshotId: string;
    sourceRemoteModifiedAt: Date | null;
    actorUserId?: string | null;
  }
): Promise<void> {
  await recordEntityChange(tx, {
    entityType: PRODUCT_ENTITY_TYPE,
    entityId: input.after.id,
    label: `Producto ${input.after.name ?? input.after.id.slice(-6)}`,
    url: `/app/products/${input.after.id}`,
    sourceSnapshotId: input.sourceSnapshotId,
    sourceRemoteModifiedAt: input.sourceRemoteModifiedAt,
    before: input.before,
    after: input.after,
    fields: PRODUCT_CHANGE_FIELDS,
    actorUserId: input.actorUserId ?? null,
    metadata: { number: input.after.name ?? null },
  });
}
