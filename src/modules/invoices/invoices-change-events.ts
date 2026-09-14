import { Prisma } from '@prisma/client';
import { INVOICE_ENTITY_TYPE } from '@/modules/invoices/permissions';
import { recordEntityChange, type ChangeFieldSpec } from '@/modules/notifications/entity-change-service';

/**
 * Change detection for facturas ("seguimiento"). Called by the normalizer
 * inside its transaction with the row before and after the upsert.
 */

export const INVOICE_CHANGE_SELECT = {
  id: true,
  invoiceNumber: true,
  status: true,
  dueDate: true,
  total: true,
  balance: true,
  customerName: true,
  salespersonName: true,
  cfdiUuid: true,
  metodoPago: true,
} satisfies Prisma.InvoiceSelect;

export type InvoiceChangeSnapshot = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_CHANGE_SELECT }>;

export const INVOICE_CHANGE_FIELDS: ReadonlyArray<ChangeFieldSpec<InvoiceChangeSnapshot>> = [
  { key: 'status', label: 'Estado' },
  { key: 'dueDate', label: 'Vence' },
  { key: 'total', label: 'Total' },
  { key: 'balance', label: 'Saldo' },
  { key: 'customerName', label: 'Cliente' },
  { key: 'salespersonName', label: 'Vendedor' },
  { key: 'cfdiUuid', label: 'CFDI' },
  { key: 'metodoPago', label: 'Método de pago' },
];

export async function recordInvoiceChange(
  tx: Prisma.TransactionClient,
  input: {
    before: InvoiceChangeSnapshot | null;
    after: InvoiceChangeSnapshot;
    sourceSnapshotId: string;
    sourceRemoteModifiedAt: Date | null;
    actorUserId?: string | null;
  }
): Promise<void> {
  await recordEntityChange(tx, {
    entityType: INVOICE_ENTITY_TYPE,
    entityId: input.after.id,
    label: `Factura ${input.after.invoiceNumber ?? input.after.id.slice(-6)}`,
    url: `/app/invoices/${input.after.id}`,
    sourceSnapshotId: input.sourceSnapshotId,
    sourceRemoteModifiedAt: input.sourceRemoteModifiedAt,
    before: input.before,
    after: input.after,
    fields: INVOICE_CHANGE_FIELDS,
    actorUserId: input.actorUserId ?? null,
    metadata: { number: input.after.invoiceNumber ?? null },
  });
}
