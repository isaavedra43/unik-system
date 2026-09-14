import { Prisma } from '@prisma/client';
import { PACKAGE_ENTITY_TYPE } from '@/modules/packages/permissions';
import { recordEntityChange, type ChangeFieldSpec } from '@/modules/notifications/entity-change-service';

/**
 * Change detection for paquetes ("seguimiento"). Called by the normalizer
 * inside its transaction with the row before and after the upsert.
 */

export const PACKAGE_CHANGE_SELECT = {
  id: true,
  packageNumber: true,
  status: true,
  shipmentStatus: true,
  carrier: true,
  trackingNumber: true,
  shipmentDate: true,
  deliveryMethod: true,
  customerName: true,
} satisfies Prisma.PackageSelect;

export type PackageChangeSnapshot = Prisma.PackageGetPayload<{ select: typeof PACKAGE_CHANGE_SELECT }>;

export const PACKAGE_CHANGE_FIELDS: ReadonlyArray<ChangeFieldSpec<PackageChangeSnapshot>> = [
  { key: 'status', label: 'Estado' },
  { key: 'shipmentStatus', label: 'Estado de envío' },
  { key: 'carrier', label: 'Paquetería' },
  { key: 'trackingNumber', label: 'Guía' },
  { key: 'shipmentDate', label: 'Fecha de envío' },
  { key: 'deliveryMethod', label: 'Método de entrega' },
  { key: 'customerName', label: 'Cliente' },
];

export async function recordPackageChange(
  tx: Prisma.TransactionClient,
  input: {
    before: PackageChangeSnapshot | null;
    after: PackageChangeSnapshot;
    sourceSnapshotId: string;
    sourceRemoteModifiedAt: Date | null;
    actorUserId?: string | null;
  }
): Promise<void> {
  await recordEntityChange(tx, {
    entityType: PACKAGE_ENTITY_TYPE,
    entityId: input.after.id,
    label: `Paquete ${input.after.packageNumber ?? input.after.id.slice(-6)}`,
    url: `/app/packages/${input.after.id}`,
    sourceSnapshotId: input.sourceSnapshotId,
    sourceRemoteModifiedAt: input.sourceRemoteModifiedAt,
    before: input.before,
    after: input.after,
    fields: PACKAGE_CHANGE_FIELDS,
    actorUserId: input.actorUserId ?? null,
    metadata: { number: input.after.packageNumber ?? null },
  });
}
