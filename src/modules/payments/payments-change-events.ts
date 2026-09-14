import { Prisma } from '@prisma/client';
import { PAYMENT_ENTITY_TYPE } from '@/modules/payments/permissions';
import { recordEntityChange, type ChangeFieldSpec } from '@/modules/notifications/entity-change-service';

/**
 * Change detection for pagos ("seguimiento"). Called by the normalizer
 * inside its transaction with the row before and after the upsert.
 */

export const PAYMENT_CHANGE_SELECT = {
  id: true,
  paymentNumber: true,
  status: true,
  amount: true,
  balance: true,
  paymentMode: true,
  date: true,
  customerName: true,
} satisfies Prisma.CustomerPaymentSelect;

export type CustomerPaymentChangeSnapshot = Prisma.CustomerPaymentGetPayload<{ select: typeof PAYMENT_CHANGE_SELECT }>;

export const PAYMENT_CHANGE_FIELDS: ReadonlyArray<ChangeFieldSpec<CustomerPaymentChangeSnapshot>> = [
  { key: 'status', label: 'Estado' },
  { key: 'amount', label: 'Monto' },
  { key: 'balance', label: 'Saldo' },
  { key: 'paymentMode', label: 'Forma de pago' },
  { key: 'date', label: 'Fecha' },
  { key: 'customerName', label: 'Cliente' },
];

export async function recordPaymentChange(
  tx: Prisma.TransactionClient,
  input: {
    before: CustomerPaymentChangeSnapshot | null;
    after: CustomerPaymentChangeSnapshot;
    sourceSnapshotId: string;
    sourceRemoteModifiedAt: Date | null;
    actorUserId?: string | null;
  }
): Promise<void> {
  await recordEntityChange(tx, {
    entityType: PAYMENT_ENTITY_TYPE,
    entityId: input.after.id,
    label: `Pago ${input.after.paymentNumber ?? input.after.id.slice(-6)}`,
    url: `/app/payments/${input.after.id}`,
    sourceSnapshotId: input.sourceSnapshotId,
    sourceRemoteModifiedAt: input.sourceRemoteModifiedAt,
    before: input.before,
    after: input.after,
    fields: PAYMENT_CHANGE_FIELDS,
    actorUserId: input.actorUserId ?? null,
    metadata: { number: input.after.paymentNumber ?? null },
  });
}
